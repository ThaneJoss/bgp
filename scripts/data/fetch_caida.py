import urllib.request,re,pathlib,json,concurrent.futures,datetime
root=pathlib.Path(__file__).parent
spec=[('relationships','https://data.caida.org/datasets/as-relationships/serial-1/',r'(\d{8}\.as-rel\.txt\.bz2)'),('organizations','https://data.caida.org/datasets/as-organizations/',r'(\d{8}\.as-org2info\.txt\.gz)')]
def fetch(s):
 key,base,pattern=s
 req=urllib.request.Request(base,headers={'User-Agent':'Mozilla/5.0'})
 with urllib.request.urlopen(req,timeout=30) as r: listing=r.read().decode()
 (root/(key+'-index.html')).write_text(listing)
 files=sorted(set(re.findall(pattern,listing)))
 files=[f for f in files if f[:8]<=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d')]
 name=files[-1]
 print(key,'latest',name,flush=True)
 with urllib.request.urlopen(urllib.request.Request(base+name,headers={'User-Agent':'Mozilla/5.0'}),timeout=45) as r: content=r.read()
 (root/name).write_bytes(content)
 print('saved',name,len(content),flush=True)
 return key,{'url':base+name,'filename':name,'snapshotDate':name[:4]+'-'+name[4:6]+'-'+name[6:8],'bytes':len(content)}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: sources=dict(pool.map(fetch,spec))
(root/'sources.json').write_text(json.dumps(sources,indent=2))
