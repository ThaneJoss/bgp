from pathlib import Path
import sys,json,bz2,time
ROOT=Path(__file__).parent
sys.path.insert(0,str(ROOT/'python-deps'))
import networkx as nx
start=time.monotonic(); sources=json.loads((ROOT/'sources.json').read_text())
g=nx.Graph()
with bz2.open(ROOT/sources['relationships']['filename'],'rt') as f:
 for line in f:
  if line.startswith('#') or not line.strip():continue
  a,b,*_=line.split('|');g.add_edge(int(a),int(b))
print('Graph loaded',g.number_of_nodes(),g.number_of_edges(),'seconds',round(time.monotonic()-start,1),flush=True)
communities=nx.community.louvain_communities(g,resolution=1,seed=42)
communities=sorted(communities,key=lambda c:(-len(c),min(c)))
modularity=nx.community.modularity(g,communities,resolution=1)
print('Raw communities',len(communities),'modularity',modularity,'sizes',[len(c) for c in communities],'seconds',round(time.monotonic()-start,1),flush=True)
raw_count=len(communities); raw_sizes=[len(c) for c in communities]; merged=0
# Louvain can leave disconnected pieces in a community; split them before edge-based merges.
communities=[set(part) for c in communities for part in nx.connected_components(g.subgraph(c))]
split_count=len(communities)
while len(communities)>20:
 owner={a:i for i,c in enumerate(communities) for a in c}
 idx=min(range(len(communities)),key=lambda i:(len(communities[i]),min(communities[i])))
 weights={}
 for a in communities[idx]:
  for b in g[a]:
   target=owner[b]
   if target!=idx:weights[target]=weights.get(target,0)+1
 if not weights:raise RuntimeError('Disconnected community has no adjacent target; retain explicit Other instead of artificial assignment')
 target=max(weights,key=lambda j:(weights[j],len(communities[j]),-min(communities[j])))
 communities[target].update(communities[idx]);del communities[idx];merged+=1
communities=sorted(communities,key=lambda c:(-len(c),min(c)))
final_modularity=nx.community.modularity(g,communities,resolution=1)
result={'method':'Louvain','networkxVersion':nx.__version__,'resolution':1,'randomSeed':42,'rawCommunityCount':raw_count,'rawCommunitySizes':raw_sizes,'connectedCommunityCount':split_count,'rawModularity':modularity,'mergedCommunityCount':merged,'finalCommunityCount':len(communities),'finalModularity':final_modularity,'mergeMethod':'Split raw communities into connected components; until at most 20 communities remain, merge the smallest community into its adjacent community with the greatest number of observed links; ties favor larger destination, then lowest ASN.','communities':[sorted(c) for c in communities]}
(ROOT/'communities.json').write_text(json.dumps(result,separators=(',',':')))
print('FINAL',len(communities),'modularity',final_modularity,'sizes',[len(c) for c in communities],'seconds',round(time.monotonic()-start,1),flush=True)
