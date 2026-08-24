#!/usr/bin/env python3
import json, subprocess, sys, tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent

def run(*args, expect=0):
    p=subprocess.run([sys.executable,*map(str,args)],text=True,capture_output=True)
    if p.returncode!=expect:
        raise AssertionError(f'cmd failed {args}: {p.returncode}\n{p.stdout}\n{p.stderr}')
    return p

def write(p,data): p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def main():
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)/'F-TEST-001'
        run(HERE/'scaffold-envelope.py','--finding-id','F-TEST-001','--title','test','--output',root)
        # Make a valid incomplete envelope.
        finding=json.loads((root/'finding.json').read_text()); finding['reviewState']='INCOMPLETE'; write(root/'finding.json',finding)
        claims=json.loads((root/'claims.json').read_text()); claims['claims'][0]['material']=False; write(root/'claims.json',claims)
        comp=json.loads((root/'completeness.json').read_text()); comp['reviewState']='INCOMPLETE'; comp['materialUnresolvedHypothesisIds']=['H-001']; write(root/'completeness.json',comp)
        decision=json.loads((root/'decision.json').read_text()); decision.update({'reviewState':'INCOMPLETE','nextEvidenceAction':'capture discriminating shape','stopCondition':'first natural failure or approved time limit'}); write(root/'decision.json',decision)
        run(HERE/'build-manifest.py',root)
        run(HERE/'validate-envelope.py',root)
        # Complete Issue case.
        finding['reviewState']='COMPLETE_ISSUE'; write(root/'finding.json',finding)
        ev=json.loads((root/'evidence-index.json').read_text()); ev['evidence'][0].update({'id':'E-001','title':'direct evidence'}); write(root/'evidence-index.json',ev)
        claims['claims'][0].update({'material':True,'evidenceIds':['E-001']}); write(root/'claims.json',claims)
        hy=json.loads((root/'hypotheses.json').read_text()); hy['hypotheses'][0].update({'status':'SUPPORTED','materialToDecision':True}); write(root/'hypotheses.json',hy)
        for g in comp['gates']:
            if g['id'] in {'G1','G2','G3','G4','G5','G8','G9','G10'}: g['status']='PASS'
        comp['materialUnresolvedHypothesisIds']=[]; comp['reviewState']='COMPLETE_ISSUE'; write(root/'completeness.json',comp)
        decision.update({'reviewState':'COMPLETE_ISSUE','recommendation':'ISSUE','decisiveEvidenceIds':['E-001'],'nextEvidenceAction':'','stopCondition':''}); write(root/'decision.json',decision)
        run(HERE/'build-manifest.py',root)
        run(HERE/'validate-envelope.py',root)
        # Registry lifecycle: register at judging, enter terminal, block implicit reopen, then audit explicit reopen.
        workspace=Path(td)/'workspace'
        run(HERE/'finding_manager.py','--workspace',workspace,'register','--envelope',root,'--owner','reviewer','--priority','P1','--stage','JUDGING','--actor','self-test')
        listed=run(HERE/'finding_manager.py','--workspace',workspace,'list','--json')
        pool=json.loads(listed.stdout)['findings'][0]
        assert pool['finding_id']=='F-TEST-001'
        assert pool['observation']==finding['observation'] and pool['evidence_count']==1
        assert pool['evidence'][0]['evidence_id']=='E-001' and pool['evidence'][0]['title']=='direct evidence'
        assert 'source' not in pool['evidence'][0] and 'source_hash' in pool['evidence'][0]
        run(HERE/'finding_manager.py','--workspace',workspace,'transition','F-TEST-001','--to','TERMINAL','--actor','self-test','--note','gates complete')
        run(HERE/'finding_manager.py','--workspace',workspace,'transition','F-TEST-001','--to','INTAKE','--actor','self-test',expect=1)
        run(HERE/'finding_manager.py','--workspace',workspace,'transition','F-TEST-001','--to','INTAKE','--actor','self-test','--note','new evidence arrived','--reopen')
        shown=json.loads(run(HERE/'finding_manager.py','--workspace',workspace,'show','F-TEST-001').stdout)
        assert shown['stage']=='INTAKE' and shown['review_state']=='INCOMPLETE'
        assert any(e['event_type']=='REOPENED' for e in shown['events']) and list((root/'review-notes').glob('reopen-*.json'))
        run(HERE/'finding_manager.py','--workspace',workspace,'update','F-TEST-001','--actor','self-test','--next-action','inspect new sample','--stop-condition','sample classified')
        run(HERE/'finding_manager.py','--workspace',workspace,'sync','F-TEST-001')
        shown=json.loads(run(HERE/'finding_manager.py','--workspace',workspace,'show','F-TEST-001').stdout)
        assert shown['next_action']=='inspect new sample' and shown['decision']['nextEvidenceAction']=='inspect new sample'
        # Invalid terminal case must fail.
        comp['materialUnresolvedHypothesisIds']=['H-001']; write(root/'completeness.json',comp)
        run(HERE/'build-manifest.py',root)
        run(HERE/'validate-envelope.py',root,expect=1)
    print('SELF_TEST_OK')
if __name__=='__main__': main()
