"""Local HTTP tests for streaming R2 transport; no cloud or upstream access."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import os
import urllib.request
import json
import threading
import unittest
from unittest.mock import patch
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit, parse_qs

from r2_http_client import R2HTTPClient, GatewayError


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def handle_request(self):
        state = self.server.state
        state['calls'].append((self.command, self.path, dict(self.headers)))
        if self.headers.get('Authorization') != 'Bearer test-token':
            return self.respond(401)
        if self.path == '/redirect':
            return self.respond(302, headers={'Location': '/objects/target'})
        if self.path.startswith('/objects?') or self.path == '/objects':
            cursor = parse_qs(urlsplit(self.path).query).get('cursor', [None])[0]
            return self.respond(200, json.dumps({'Contents': [{'Key': cursor or 'first', 'Size': 1}],
                                                'NextCursor': 'next token' if cursor is None else None}).encode())
        key = unquote(urlsplit(self.path).path.split('/', 2)[2])
        objects = state['objects']
        if self.command == 'DELETE':
            objects.pop(key, None)
            return self.respond(204)
        if self.command in ('GET', 'HEAD'):
            if key not in objects:
                return self.respond(404)
            raw, meta = objects[key]
            return self.respond(200, raw, {'ETag': '"fixture"', 'x-amz-meta-sha256': meta})
        raw = self.rfile.read(int(self.headers['Content-Length']))
        if len(raw) != int(self.headers['Content-Length']):
            return  # The client closed an intentionally truncated upload.
        if state.get('failure') and self.path.startswith('/compose/'):
            return self.respond(state['failure'])
        if self.path.startswith('/compose/'):
            data = json.loads(raw)
            raw = b''.join(objects[part][0] for part in data['parts'])
            assert len(raw) == data['size']
        if self.headers.get('If-None-Match') == '*' and key in objects:
            return self.respond(412)
        if self.headers.get('Content-MD5'):
            assert base64.b64encode(hashlib.md5(raw).digest()).decode() == self.headers['Content-MD5']
        objects[key] = (raw, self.headers.get('x-amz-meta-sha256', ''))
        return self.respond(200, headers={'ETag': '"fixture"'})

    def respond(self, status, raw=b'', headers=None):
        self.send_response(status)
        self.send_header('Content-Length', str(len(raw)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(raw)

    do_GET = do_HEAD = do_PUT = do_POST = do_DELETE = handle_request


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.server.state = {'objects': {}, 'calls': []}
        self.client = R2HTTPClient(f'http://127.0.0.1:{self.server.server_port}', 'test-token', part_size=8)

    def put(self, raw, key='snapshots/test/file'):
        return self.client.put_object(Bucket='ignored', Key=key, Body=io.BytesIO(raw), ContentLength=len(raw),
                                     ContentMD5=base64.b64encode(hashlib.md5(raw).digest()).decode(),
                                     Metadata={'sha256': hashlib.sha256(raw).hexdigest()}, IfNoneMatch='*')

    def test_small_empty_and_streaming_compose_with_cleanup(self):
        for raw in (b'', b'short', b'long payload requiring several parts'):
            key = f'snapshots/test/{len(raw)}'
            self.put(raw, key)
            got = self.client.get_object(Bucket='', Key=key)
            with got['Body'] as body:
                self.assertEqual(body.read(), raw)
            self.assertEqual(got['ETag'], '"fixture"')
            head = self.client.head_object(Bucket='', Key=key)
            self.assertEqual(head['ContentLength'], len(raw))
            self.assertEqual(head['Metadata']['sha256'], hashlib.sha256(raw).hexdigest())
        self.assertFalse(any(key.startswith('_uploads/') for key in self.server.state['objects']))
        self.assertTrue(any('%2F' in path for _, path, _ in self.server.state['calls']))

    def test_failure_mapping_cleanup_and_redirect_not_followed(self):
        self.server.state['failure'] = 409
        with self.assertRaises(GatewayError) as caught:
            self.put(b'payload requiring parts')
        self.assertEqual(caught.exception.response['Error']['Code'], 'ConditionalRequestConflict')
        self.assertEqual(self.server.state['objects'], {})
        with self.assertRaises(GatewayError) as caught:
            self.client.get_object(Bucket='', Key='missing')
        self.assertEqual(caught.exception.response['Error']['Code'], 'NoSuchKey')
        before = len(self.server.state['calls'])
        with self.assertRaises(GatewayError):
            self.client._request('GET', '/redirect')
        self.assertEqual(len(self.server.state['calls']), before + 1)
        self.client.token = 'wrong'
        with self.assertRaises(GatewayError) as caught:
            self.client.head_object(Bucket='', Key='missing')
        self.assertEqual(caught.exception.response['Error']['Code'], '401')

    def test_conditions_and_short_pages(self):
        self.put(b'first')
        with self.assertRaises(GatewayError) as caught:
            self.put(b'other')
        self.assertEqual(caught.exception.response['Error']['Code'], 'PreconditionFailed')
        pages = list(self.client.get_paginator('list_objects_v2').paginate(Bucket=''))
        self.assertEqual([p['Contents'][0]['Key'] for p in pages], ['first', 'next token'])

    def test_descriptive_user_agent_and_invalid_list_response(self):
        self.put(b'ua')
        headers = self.server.state['calls'][-1][2]
        self.assertEqual(headers['User-Agent'], 'BGP-Snapshot-Publisher/1.0 (+https://github.com/ThaneJoss/bgp)')
        response = io.BytesIO(b'not json')
        with patch.object(self.client, '_request', return_value=response):
            with self.assertRaises(json.JSONDecodeError):
                list(self.client.paginate(Bucket=''))
        self.assertTrue(response.closed)

    def test_standard_environment_proxy_and_no_proxy_selection(self):
        from r2_http_client import NoRedirect
        with patch.dict(os.environ, {'HTTPS_PROXY': 'http://proxy.invalid:8080',
                                     'NO_PROXY': '127.0.0.1'}, clear=True):
            opener = urllib.request.build_opener(NoRedirect())
            proxy = next(handler for handler in opener.handlers if isinstance(handler, urllib.request.ProxyHandler))
            self.assertEqual(proxy.proxies['https'], 'http://proxy.invalid:8080')
            self.assertTrue(urllib.request.proxy_bypass('127.0.0.1'))
            self.assertFalse(urllib.request.proxy_bypass('gateway.example'))
            # This request must bypass the unavailable proxy and reach localhost.
            self.put(b'local')

    def test_cleanup_attempts_every_part_and_preserves_upload_error(self):
        self.server.state['failure'] = 412
        cleanup_calls = []
        def broken_cleanup(**kwargs):
            cleanup_calls.append(kwargs['Key'])
            raise RuntimeError('cleanup failed')
        with patch.object(self.client, 'delete_object', side_effect=broken_cleanup):
            with self.assertRaises(GatewayError) as caught:
                self.put(b'payload requiring three parts')
        self.assertEqual(caught.exception.response['Error']['Code'], 'PreconditionFailed')
        self.assertEqual(len(cleanup_calls), 4)

    def test_truncated_source_cleans_created_parts(self):
        with self.assertRaisesRegex(ValueError, 'ended before'):
            self.client.put_object(Bucket='', Key='snapshots/truncated', Body=io.BytesIO(b'ab'),
                                   ContentLength=9, ContentMD5='unused', Metadata={'sha256': 'unused'})
        self.assertFalse(any(key.startswith('_uploads/') for key in self.server.state['objects']))

    def test_publish_budget_includes_temporary_parts(self):
        from test_pipeline import CONFIG, FakeR2, fixture
        from publish_snapshot import fetch_previous, publish, MANIFEST_LIMIT
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            client = FakeR2()
            client.part_size = 8
            fetch_previous(client, 'test', root / 'prior', CONFIG)
            output = root / 'snapshot'
            manifest = fixture(output, 1)
            files = [output / item['key'] for item in manifest['files']]
            files += [output / 'manifest.json', output / manifest['diff']]
            maximum = sum(path.stat().st_size for path in files) + MANIFEST_LIMIT
            config = {**CONFIG, 'publish': {**CONFIG['publish'], 'maxManagedBytes': maximum}}
            with self.assertRaisesRegex(ValueError, 'bucket budget'):
                publish(client, 'test', output, root / 'prior/previous.json', config)
            self.assertFalse(any(operation == 'put' for operation, _ in client.calls))


if __name__ == '__main__':
    unittest.main()
