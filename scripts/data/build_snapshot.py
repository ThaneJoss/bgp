import json, gzip, bz2, pathlib, hashlib, heapq, collections
ROOT=pathlib.Path(__file__).parent
sources=json.loads((ROOT/'sources.json').read_text())
orgs={}; asinfo={}; mode=None
with gzip.open(ROOT/sources['organizations']['filename'],'rt') as f:
 for line in f:
  if line.startswith('# format:org_id'): mode='org';continue
  if line.startswith('# format:aut'): mode='as';continue
  if line.startswith('#') or not line.strip():continue
  fields=line.rstrip('\n').split('|')
  if mode=='org': orgs[fields[0]]={'name':fields[2],'country':fields[3]}
  elif mode=='as': asinfo[int(fields[0])]={'name':fields[2],'orgId':fields[3]}
links=[]; adj=collections.defaultdict(set); raw_count=0; seen=set(); dates=set(); clique=[]
with bz2.open(ROOT/sources['relationships']['filename'],'rt') as f:
 for line in f:
  if line.startswith('# input clique:'): clique=[int(v) for v in line.split(':')[1].split()]
  if line.startswith('# source:topology|BGP|'):dates.add(line.split('|')[2])
  if line.startswith('#') or not line.strip():continue
  fields=line.strip().split('|'); a,b,r=int(fields[0]),int(fields[1]),int(fields[2]);raw_count+=1
  key=(min(a,b),max(a,b))
  if key in seen:continue
  seen.add(key); links.append((a,b,r));adj[a].add(b);adj[b].add(a)
all_asns=sorted(adj)
def orgof(a):return asinfo.get(a,{}).get('orgId',f'unknown-AS{a}')
org_members=collections.defaultdict(list)
for a in all_asns:org_members[orgof(a)].append(a)
external_neighbors=collections.defaultdict(set)
for a,b,r in links:
 oa,ob=orgof(a),orgof(b)
 if oa!=ob:external_neighbors[oa].add(b);external_neighbors[ob].add(a)
community_result=json.loads((ROOT/'communities.json').read_text())
community_sets=[set(c) for c in community_result['communities']]
membership={rank:list(c) for rank,c in enumerate(community_sets)}
owner={a:rank for rank,c in enumerate(community_sets) for a in c}
assert set(owner)==set(all_asns)
seed_orgs=[]; community_seed_asns={}; best={}
for rank,c in enumerate(community_sets):
 primary=min(c,key=lambda a:(-len(adj[a]),a))
 o=orgof(primary); seed_orgs.append(o)
 community_seed_asns[rank]=sorted((a for a in c if orgof(a)==o),key=lambda a:(-len(adj[a]),a))
 distances={primary:0}; queue=collections.deque([primary])
 while queue:
  a=queue.popleft()
  for b in adj[a]:
   if b in c and b not in distances:distances[b]=distances[a]+1;queue.append(b)
 assert set(distances)==c, f'Community {rank} is not connected'
 for a,d in distances.items():best[a]=(d,rank)
unassigned=[]
# Only graph-derived, observed links appear in drill-down, never synthetic attachments.
group_internal=collections.defaultdict(list);group_edges=collections.defaultdict(lambda: {'count':0,'peerCount':0,'providerCustomerCount':0})
for a,b,r in links:
 if a not in best or b not in best:continue
 ga,gb=best[a][1],best[b][1]
 if ga==gb:group_internal[ga].append((a,b,r))
 else:
  edge=group_edges[tuple(sorted((ga,gb)))];edge['count']+=1;edge['peerCount']+=r==0;edge['providerCustomerCount']+=r==-1
palette=['#56c8e8','#9ba3f7','#5dd6ad','#ebba70','#e58bc4','#f28282','#74bbf0','#c3c971','#7cd4c7','#b895e2','#ddaa86','#97c6d8','#84be94','#e4d18a','#c28298','#9cbded','#d8a96e','#a6d2b9','#c7b8eb','#e6a8a0']
def member(a):
 info=asinfo.get(a,{})
 org=orgs.get(orgof(a),{})
 return {'asn':a,'name':info.get('name',f'AS{a}'),'organization':org.get('name','Unknown organization'),'country':org.get('country',''),'degree':len(adj[a]),'distance':best[a][0] if a in best else None}
groups=[]
for rank,o in enumerate(seed_orgs):
 ordered=sorted(membership[rank],key=lambda a:(-len(adj[a]),a))
 seed_asns=community_seed_asns[rank]
 visible=list(dict.fromkeys(seed_asns[:24]+ordered[:96]))[:120]
 visible_set=set(visible)
 internal=sorted([e for e in group_internal[rank] if e[0] in visible_set and e[1] in visible_set],key=lambda e:(-(len(adj[e[0]])+len(adj[e[1]])),e[0],e[1]))
 full_name=orgs.get(o,{}).get('name',o)
 group={'id':f'g{rank+1:02d}','label':full_name,'organizationId':o,'seedAsn':seed_asns[0],'seedAsns':seed_asns,'seedOrganizationAsnCount':len(seed_asns),'externalNeighborAsnCount':len({b for a in ordered for b in adj[a] if owner[b]!=rank}),'country':orgs.get(o,{}).get('country',''),'color':palette[rank%len(palette)],'asnCount':len(ordered),'organizationCount':len(set(orgof(a) for a in ordered)),'internalLinkCount':len(group_internal[rank]),'members':[member(a) for a in visible],'visibleMemberCount':len(visible),'memberSample':'Seed ASNs and highest-degree members, at most 120 ASNs.','internalLinks':[{'source':a,'target':b,'relationship':'peer' if r==0 else 'provider-customer'} for a,b,r in internal[:1500]],'visibleInternalLinkCount':min(1500,len(internal)),'totalLinksBetweenVisibleMembers':len(internal),'distanceDistribution':dict(sorted(collections.Counter(best[a][0] for a in ordered).items()))}
 groups.append(group)
 (ROOT/'groups').mkdir(exist_ok=True)
 (ROOT/'groups'/f'{group["id"]}.json').write_text(json.dumps({'groupId':group['id'],'members':[member(a) for a in ordered]},separators=(',',':')))
meta={'source':'CAIDA AS Relationships (serial-1) and AS Organizations','date':sources['relationships']['snapshotDate'],'organizationDate':sources['organizations']['snapshotDate'],'fetchedDate':'2026-09-22','totalAS':len(all_asns),'totalLinks':len(links),'rawRelationshipRows':raw_count,'totalOrganizations':len(org_members),'groupCount':len(groups),'assignedAS':len(best),'unassignedAS':len(unassigned),'unassignedAsns':unassigned,'peerLinks':sum(r==0 for a,b,r in links),'providerCustomerLinks':sum(r==-1 for a,b,r in links),'betweenGroupLinks':sum(e['count'] for e in group_edges.values()),'withinGroupLinks':sum(len(e) for e in group_internal.values()),'grouping':'Topology communities detected with Louvain modularity optimization on the complete undirected, unweighted observed AS graph (NetworkX 3.7; resolution 1; random seed 42). Split communities into connected components; if more than 20 remain, repeatedly merge the smallest into its strongest adjacent community by observed edge count, breaking ties by destination size then lowest ASN. Group names identify the organization of the highest-degree member ASN; they do not imply ownership, geography, or commercial allegiance.','groupingZh':'使用 Louvain 算法按实际 AS 连接结构划分拓扑社群；小社群按真实连接数并入联系最紧密的相邻社群。名称取自组内连接最多的 ASN 所属组织，仅用于识别，不表示组织所有权、地理区域或商业关系。','memberSampling':'Each group detail previews up to 120 seed/highest-degree ASNs and at most 1500 observed links among preview ASNs. Full ASN-to-group mapping and complete member detail files are provided separately.','coverage':'ASNs and relationships observed or inferred in this CAIDA snapshot, not a complete real-time census of the Internet. BGP-derived relationship data are not physical cables or live traffic.','relationshipMeaning':{'peer':'CAIDA relationship 0: peer-to-peer','provider-customer':'CAIDA relationship -1: source provider, target customer'},'sources':sources,'bgpObservationDates':sorted(dates),'inputClique':clique}
meta['communityDetection']={k:v for k,v in community_result.items() if k!='communities'}
meta['memberDistanceMeaning']='Shortest undirected path inside the community from its highest-degree representative ASN.'
for source in sources.values():source['sha256']=hashlib.sha256((ROOT/source['filename']).read_bytes()).hexdigest()
result={'meta':meta,'groups':groups,'links':[{'source':f'g{a+1:02d}','target':f'g{b+1:02d}',**v} for (a,b),v in sorted(group_edges.items())]}
(ROOT/'topology.json').write_text(json.dumps(result,separators=(',',':'),ensure_ascii=False))
(ROOT/'asn-groups.json').write_text(json.dumps({str(a):(f'g{best[a][1]+1:02d}' if a in best else None) for a in all_asns},separators=(',',':')))
(ROOT/'asn-index.json').write_text(json.dumps({str(a):[f'g{best[a][1]+1:02d}' if a in best else None,asinfo.get(a,{}).get('name',f'AS{a}'),len(adj[a])] for a in all_asns},separators=(',',':'),ensure_ascii=False))
(ROOT/'metadata.json').write_text(json.dumps(meta,indent=2))
# Verify graph and aggregation invariants.
assert sum(g['asnCount'] for g in groups)+len(unassigned)==len(all_asns)
assert len({g['id'] for g in groups})==len(community_sets)
assert all(a in adj[b] for a in adj for b in adj[a])
assert all(len(g['members'])==len({m['asn'] for m in g['members']}) for g in groups)
for g in groups:
 visible={m['asn'] for m in g['members']}
 assert all(e['source'] in visible and e['target'] in visible and e['target'] in adj[e['source']] for e in g['internalLinks'])
print(json.dumps({k:v for k,v in meta.items() if k in ['date','totalAS','totalLinks','totalOrganizations','assignedAS','unassignedAS','peerLinks','providerCustomerLinks','betweenGroupLinks','withinGroupLinks']},indent=2))
for g in groups:print(g['id'],g['label'],'seed',g['seedAsn'],'ASNs',g['asnCount'],'orgSeedASNs',g['seedOrganizationAsnCount'],'externalNeighborASNs',g['externalNeighborAsnCount'])
for f in ['topology.json','asn-groups.json','asn-index.json']:print(f,(ROOT/f).stat().st_size)
