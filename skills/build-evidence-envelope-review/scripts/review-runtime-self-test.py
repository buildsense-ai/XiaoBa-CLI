#!/usr/bin/env python3
"""Regression tests for the human-triggered Review Agent Runtime v0.1."""
import importlib.util, json, subprocess, sys, tempfile
from pathlib import Path

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('runtime', HERE/'review_runtime.py')
rt=importlib.util.module_from_spec(spec); spec.loader.exec_module(rt)
fm_spec=importlib.util.spec_from_file_location('finding_manager', HERE/'finding_manager.py')
fm=importlib.util.module_from_spec(fm_spec); fm_spec.loader.exec_module(fm)

def run(*args, expect=0):
    p=subprocess.run([sys.executable,*map(str,args)],text=True,capture_output=True)
    if p.returncode != expect: raise AssertionError(f'{args}: {p.stdout}\n{p.stderr}')
    return p

def write(path,value): path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def make_envelope(root, finding_id, state='INCOMPLETE'):
    run(HERE/'scaffold-envelope.py','--finding-id',finding_id,'--title','runtime test','--output',root)
    finding=json.loads((root/'finding.json').read_text()); finding['reviewState']=state; write(root/'finding.json',finding)
    claims=json.loads((root/'claims.json').read_text()); claims['claims'][0]['material']=False; write(root/'claims.json',claims)
    comp=json.loads((root/'completeness.json').read_text()); comp['reviewState']=state; comp['materialUnresolvedHypothesisIds']=['H-001'] if state=='INCOMPLETE' else []; write(root/'completeness.json',comp)
    decision=json.loads((root/'decision.json').read_text()); decision.update({'reviewState':state,'nextEvidenceAction':'collect a discriminating sample' if state=='INCOMPLETE' else '','stopCondition':'first safe sample or approved expiry' if state=='INCOMPLETE' else ''}); write(root/'decision.json',decision)
    run(HERE/'build-manifest.py',root); run(HERE/'validate-envelope.py',root)

def main():
  with tempfile.TemporaryDirectory() as td:
    root=Path(td); workspace=root/'workspace'; envelope=root/'F-RUNTIME-001'; make_envelope(envelope,'F-RUNTIME-001')
    conn=rt.connect(workspace)
    try:
      fm.register(conn,envelope,owner='tester',priority='P1',actor='self-test',stage='COLLECTING')
      run_id=rt.create_run(conn,'F-RUNTIME-001','reviewer','verify human approval and recovery','self-test')
      try: rt.run_state(conn,run_id,'RUNNING','self-test')
      except ValueError: pass
      else: raise AssertionError('DRAFT must not jump to RUNNING')
      rt.run_state(conn,run_id,'READY','self-test'); rt.run_state(conn,run_id,'RUNNING','self-test')
      task_id=rt.create_task(conn,run_id,'COLLECT','collect only synthetic evidence','no production access; no payloads','synthetic-evidence.json','one fixture written','self-test')
      try: rt.task_state(conn,task_id,'RUNNING','self-test')
      except ValueError: pass
      else: raise AssertionError('unapproved task must not RUN')
      rt.approve_task(conn,task_id,'human-approver','approved synthetic fixture')
      rt.task_state(conn,task_id,'RUNNING','self-test')
      artifact=root/'synthetic-evidence.json'; artifact.write_text('{"safe":true}\n',encoding='utf-8')
      summary=rt.complete_task(conn,task_id,'self-test','fixture stored',artifact)
      assert summary['review_state']=='INCOMPLETE'
      summary=rt.judge(conn,run_id,'self-test','decision needs human follow-up')
      shown=rt.show(conn,run_id)
      assert shown['state']=='AWAITING_APPROVAL' and shown['decision_state']=='INCOMPLETE'
      assert shown['tasks'][0]['artifact_hash'] and shown['tasks'][0]['approved_by']=='human-approver'
      assert any(e['event_type']=='ENVELOPE_VALIDATED_AND_SYNCED' for e in shown['events'])
      rt.run_state(conn,run_id,'PAUSED','human-approver','waiting on safe sample window')
      rt.run_state(conn,run_id,'RUNNING','human-approver','resume approved')
      events=conn.execute("SELECT event_type FROM events WHERE finding_id='F-RUNTIME-001'").fetchall()
      assert any(x['event_type']=='REVIEW_RUN_CREATED' for x in events)
    finally: conn.close()
  print('REVIEW_RUNTIME_SELF_TEST_OK')
if __name__=='__main__': main()
