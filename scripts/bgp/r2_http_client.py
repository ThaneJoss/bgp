"""Streaming authenticated transport for the private R2 publication gateway."""
from __future__ import annotations

import urllib.error
import urllib.request
import json
import uuid
from urllib.parse import quote, urlencode, urlsplit

PART_SIZE = 64 * 1024 * 1024


class GatewayError(Exception):
    def __init__(self, status):
        code = {404: 'NoSuchKey', 412: 'PreconditionFailed', 409: 'ConditionalRequestConflict'}.get(status, str(status))
        self.response = {'Error': {'Code': code}}
        super().__init__(f'R2 publication gateway returned HTTP {status}')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None


class ResponseBody:
    def __init__(self, response):
        self.response = response

    def read(self, size=-1):
        return self.response.read(size)

    def close(self):
        self.response.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class LimitedReader:
    def __init__(self, source, length):
        self.source, self.remaining = source, length

    def read(self, size=-1):
        size = self.remaining if size < 0 else min(size, self.remaining)
        if not size:
            return b''
        block = self.source.read(size)
        if not block:
            raise ValueError('Upload source ended before ContentLength')
        self.remaining -= len(block)
        return block


class R2HTTPClient:
    def __init__(self, url, token, *, part_size=PART_SIZE):
        parsed = urlsplit(url)
        local = parsed.hostname in ('localhost', '127.0.0.1', '::1')
        if (parsed.scheme != 'https' and not (local and parsed.scheme == 'http')) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('R2_PUBLISH_URL must be an HTTPS gateway URL')
        if not token or '\r' in token or '\n' in token:
            raise ValueError('Invalid R2_PUBLISH_TOKEN')
        self.url, self.token, self.part_size = parsed, token, part_size

    def _request(self, method, path, body=None, headers=None):
        request_headers = {'Authorization': f'Bearer {self.token}',
                           'User-Agent': 'BGP-Snapshot-Publisher/1.0 (+https://github.com/ThaneJoss/bgp)',
                           **(headers or {})}
        url = self.url.geturl().rstrip('/') + path
        request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
        # Default ProxyHandler honors HTTPS_PROXY and NO_PROXY. Redirects never
        # resend the request or its bearer token to another URL.
        opener = urllib.request.build_opener(NoRedirect())
        try:
            response = opener.open(request, timeout=300)
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            raise GatewayError(status) from None
        if not 200 <= response.status < 300:
            status = response.status
            response.close()
            raise GatewayError(status)
        return response

    @staticmethod
    def _path(key):
        return '/objects/' + quote(key, safe='')

    def get_object(self, *, Bucket, Key):
        response = self._request('GET', self._path(Key))
        try:
            return {'Body': ResponseBody(response), 'ContentLength': int(response.getheader('Content-Length')),
                    'ETag': response.getheader('ETag')}
        except Exception:
            response.close()
            raise

    def head_object(self, *, Bucket, Key):
        response = self._request('HEAD', self._path(Key))
        try:
            return {'ContentLength': int(response.getheader('Content-Length')), 'ETag': response.getheader('ETag'),
                    'Metadata': {'sha256': response.getheader('x-amz-meta-sha256')}}
        finally:
            response.close()

    def _empty_request(self, method, path, body=None, headers=None):
        response = self._request(method, path, body, headers)
        try:
            return {'ETag': response.getheader('ETag')}
        finally:
            response.close()

    def delete_object(self, *, Bucket, Key):
        return self._empty_request('DELETE', self._path(Key))

    def put_object(self, *, Bucket, Key, Body, ContentLength, ContentMD5, Metadata,
                   ContentType='application/octet-stream', CacheControl='', IfMatch=None, IfNoneMatch=None):
        headers = {'Content-Length': str(ContentLength), 'Content-MD5': ContentMD5,
                   'Content-Type': ContentType, 'Cache-Control': CacheControl,
                   'x-amz-meta-sha256': Metadata['sha256']}
        if IfMatch is not None:
            headers['If-Match'] = IfMatch
        if IfNoneMatch is not None:
            headers['If-None-Match'] = IfNoneMatch
        if ContentLength <= self.part_size:
            source = Body if isinstance(Body, bytes) else LimitedReader(Body, ContentLength)
            return self._empty_request('PUT', self._path(Key), source, headers)
        import io
        source = io.BytesIO(Body) if isinstance(Body, bytes) else Body
        parts = []
        try:
            remaining = ContentLength
            prefix = '_uploads/' + uuid.uuid4().hex
            while remaining:
                size = min(remaining, self.part_size)
                key = f'{prefix}/{len(parts)}'
                # Track before sending: even a lost response can leave an object.
                parts.append(key)
                self._empty_request('PUT', self._path(key), LimitedReader(source, size),
                                    {'Content-Length': str(size), 'Content-Type': 'application/octet-stream', 'If-None-Match': '*'})
                remaining -= size
            payload = json.dumps({'parts': parts, 'size': ContentLength}).encode()
            headers['Content-Length'] = str(len(payload))
            return self._empty_request('POST', '/compose/' + quote(Key, safe=''), payload, headers)
        finally:
            import sys
            active_error = sys.exc_info()[0] is not None
            cleanup_error = None
            for key in parts:
                try:
                    self.delete_object(Bucket=Bucket, Key=key)
                except Exception as error:
                    cleanup_error = cleanup_error or error
            if cleanup_error is not None and not active_error:
                raise cleanup_error

    def get_paginator(self, name):
        if name != 'list_objects_v2':
            raise ValueError('Unsupported paginator')
        return self

    def paginate(self, *, Bucket):
        cursor = None
        while True:
            path = '/objects' + ('?' + urlencode({'cursor': cursor}) if cursor is not None else '')
            response = self._request('GET', path)
            try:
                page = json.load(response)
            finally:
                response.close()
            yield {'Contents': page['Contents']}
            next_cursor = page['NextCursor']
            if next_cursor is None:
                return
            if not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor:
                raise ValueError('Invalid publication gateway pagination cursor')
            cursor = next_cursor
