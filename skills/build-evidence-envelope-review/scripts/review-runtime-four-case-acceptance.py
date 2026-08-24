#!/usr/bin/env python3
"""Four-case isolated acceptance for Review Agent Runtime v0.1.

Fixtures are synthetic except F-2026-001, which is checked in-place only as an
INCOMPLETE regression package. No production endpoint, user data, or Finding Pool
mutation is used for synthetic cases.
"""
import importlib.util, json, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('runtime', HERE/'review_runtime.py')
rt=importlib.util.module_from_spec(spec); spec.loader.exec_module(rt)
fm_spec=importlib.util.spec_from_file_location('finding_manager', HERE/'finding_manager.py')
fm=importlib.util.module_from_spec(fm_spec); fm_spec.loader.exec_module(fm)

def cmd(*args,expect=0):
 p=subprocess.run([sys.executable,*map(str,args)],text=True,capture_output=True)
 if p.returncode!=expect: raise AssertionError(f'{args}\n{p.stdout}\n{p.stderr}')
 return p

def write(p,v): p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def load(p): return json.loads(Path(p).read_text(encoding='utf-8'))

def fixture(root,fid,title,state):
 cmd(HERE/'scaffold-envelope.py','--finding-id',fid,'--title',title,'--output',root)
 finding=load(root/'finding.json'); claims=load(root/'claims.json'); hy=load(root/'hypotheses.json'); ev=load(root/'evidence-index.json'); comp=load(root/'completeness.json'); dec=load(root/'decision.json')
 (root/'sources'/'fixture.json').write_text('{"synthetic":true,"attempts":[1,2,3,4]}\n',encoding='utf-8')
 ev['evidence'][0].update({'id':'E-001','type':'DIRECT','title':'synthetic local fixture','source':'sources/fixture.json','acquisitionMethod':'local deterministic fixture','collectedAt':'2026-07-26T00:00:00Z','redaction':'none','limitations':['synthetic acceptance evidence only']})
 claims['claims'][0].update({'statement':title,'material':state!='INCOMPLETE','confidence':'HIGH','evidenceIds':['E-001']})
 hy['hypotheses'][0].update({'status':'UNRESOLVED' if state=='INCOMPLETE' else 'SUPPORTED','materialToDecision':state!='INCOMPLETE'})
 if state=='INCOMPLETE':
  claims['claims'][0]['material']=False; comp['materialUnresolvedHypothesisIds']=['H-001']; dec.update({'reviewState':state,'recommendation':None,'nextEvidenceAction':'capture one approved discriminating fixture','stopCondition':'fixture classified or approval expires'})
 else:
  for g in comp['gates']:
   if g['id'] in {'G1','G2','G3','G4','G5','G8','G9','G10'}: g['status']='PASS'
  comp['materialUnresolvedHypothesisIds']=[]; dec.update({'reviewState':state,'recommendation':'ISSUE' if state=='COMPLETE_ISSUE' else 'CLOSE','decisiveEvidenceIds':['E-001'],'nextEvidenceAction':'','stopCondition':''})
 finding['reviewState']=state; comp['reviewState']=state
 write(root/'finding.json',finding); write(root/'claims.json',claims); write(root/'hypotheses.json',hy); write(root/'evidence-index.json',ev); write(root/'completeness.json',comp); write(root/'decision.json',dec)
 cmd(HERE/'build-manifest.py',root); cmd(HERE/'validate-envelope.py',root)

def full_run(conn,root,fid,expected):
 fm.register(conn,root,owner='acceptance',priority='P2',actor='acceptance',stage='JUDGING')
 run=rt.create_run(conn,fid,'acceptance-reviewer','synthetic runtime acceptance','acceptance')
 rt.run_state(conn,run,'READY','acceptance'); rt.run_state(conn,run,'RUNNING','acceptance')
 task=rt.create_task(conn,run,'ANALYZE','verify local synthetic envelope','local files only; no network or production access','acceptance.txt','validator passes','acceptance')
 rt.approve_task(conn,task,'human-approver','synthetic-only approval'); rt.task_state(conn,task,'RUNNING','acceptance')
 artifact=root/'derived'/'acceptance.txt'; artifact.write_text('synthetic acceptance completed\n',encoding='utf-8')
 rt.complete_task(conn,task,'acceptance','local validation completed',artifact)
 summary=rt.judge(conn,run,'acceptance','terminal synthetic decision')
 shown=rt.show(conn,run)
 assert summary['review_state']==expected
 assert shown['state']==('AWAITING_APPROVAL' if expected=='INCOMPLETE' else 'DECIDED')
 assert shown['tasks'][0]['approved_by']=='human-approver' and shown['tasks'][0]['artifact_hash']
 return run,shown

def main():
 real=Path('/home/xiaoba/app/review/evidence-envelopes/findings/F-2026-001')
 cmd(HERE/'validate-envelope.py',real)
 f=load(real/'finding.json'); c=load(real/'completeness.json'); d=load(real/'decision.json')
 assert f['reviewState']==c['reviewState']==d['reviewState']=='INCOMPLETE'
 assert d.get('nextEvidenceAction') and d.get('stopCondition')
 assert {x['id'] for x in c['gates'] if x['status']=='FAIL'}=={'G5','G10'}
 results=[{'case':'F-2026-001','kind':'real regression','result':'VALID_INCOMPLETE','pool_mutated':False}]
 with tempfile.TemporaryDirectory() as td:
  base=Path(td); workspace=base/'workspace'; conn=rt.connect(workspace)
  try:
   for fid,title,state in [('F-2026-902','synthetic retry upper bound violation','COMPLETE_ISSUE'),('F-2026-903','synthetic expected idempotent retry','COMPLETE_CLOSE'),('F-2026-904','synthetic collection blocker and recovery','INCOMPLETE')]:
    root=base/fid; fixture(root,fid,title,state); run,shown=full_run(conn,root,fid,state)
    if fid=='F-2026-904':
     rt.run_state(conn,run,'PAUSED','human-approver','controlled blocker'); rt.run_state(conn,run,'RUNNING','human-approver','manual recovery approved')
     assert rt.show(conn,run)['state']=='RUNNING'
    results.append({'case':fid,'kind':'synthetic fixture','result':state,'run_id':run,'pool_mutated':False})
  finally: conn.close()
 print(json.dumps({'acceptance':'PASS','cases':results,'constraints':['synthetic cases ran in a temporary isolated workspace','F-2026-001 was validation-only','no production/network collection was invoked']},ensure_ascii=False,indent=2))
if __name__=='__main__': main()
