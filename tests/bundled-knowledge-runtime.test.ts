import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = path.resolve(__dirname, '..');

test('compiled knowledge runtime works from isolated CLI, desktop and Worker resource layouts', { timeout: 60000 }, async t => {
  assert.ok(fs.existsSync(path.join(repo, 'dist/skills/builtin-knowledge-skill.js')), 'Run npm run build first');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.equal(packageJson.build.asar, false);
  assert.ok(packageJson.build.files.includes('skills/**/*'));
  const tracked = await run('git', ['ls-files', '--', 'skills/xiaoba-knowledge'], { cwd: repo });
  assert.match(tracked.stdout, /skills\/xiaoba-knowledge\/SKILL.md/);
  assert.match(tracked.stdout, /skills\/xiaoba-knowledge\/scripts\/knowledge.cjs/);

  for (const layout of ['cli-app', 'desktop/resources/app', 'CatsCo.app/Contents/Resources/app', 'worker/releases/test/app']) {
    await t.test(layout, async () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-release-'));
      try {
        const app = path.join(fixture, layout);
        const data = path.join(fixture, '用户 数据');
        const cwd = path.join(fixture, 'unrelated-cwd');
        fs.mkdirSync(cwd, { recursive: true });
        fs.mkdirSync(data);
        fs.cpSync(path.join(repo, 'dist'), path.join(app, 'dist'), { recursive: true });
        fs.cpSync(path.join(repo, 'skills/xiaoba-knowledge'), path.join(app, 'skills/xiaoba-knowledge'), { recursive: true });
        fs.cpSync(path.join(repo, 'skills/catsco-prompt-editor'), path.join(app, 'skills/catsco-prompt-editor'), { recursive: true });
        const env = { ...process.env, NODE_PATH: path.join(repo, 'node_modules'), XIAOBA_USER_DATA_DIR: data,
          XIAOBA_SKILLS_DIR: path.join(data, 'skills'), XIAOBA_NODE_EXECUTABLE: process.execPath };
        const program = `
          const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
          const {execFileSync}=require('node:child_process');
          const app=process.argv[1],data=process.env.XIAOBA_USER_DATA_DIR;
          const {SkillManager}=require(path.join(app,'dist/skills/skill-manager'));
          const {renderKnowledgePaths}=require(path.join(app,'dist/skills/builtin-knowledge-skill'));
          (async()=>{
            const manager=new SkillManager();await manager.loadSkills();
            const skill=manager.getSkill('xiaoba-knowledge');assert.ok(skill);
            assert.equal(skill.filePath,path.join(app,'skills/xiaoba-knowledge/SKILL.md'));
            const rendered=renderKnowledgePaths(skill);assert.ok(rendered.content.includes(path.join(data,'knowledge')));
            assert.ok(rendered.content.includes(process.env.XIAOBA_NODE_EXECUTABLE));
            const script=path.join(path.dirname(skill.filePath),'scripts/knowledge.cjs');
            const call=(...args)=>JSON.parse(execFileSync(process.env.XIAOBA_NODE_EXECUTABLE,[script,'--root',path.join(data,'knowledge'),...args],{encoding:'utf8'}));
            const input=path.join(data,'request.json');
            const doc={expectedRevision:null,title:'Packaged source',summary:'Read-back verification',category:'environment',sources:['synthetic fixture'],change:'create',body:'Original packaged knowledge'};
            fs.writeFileSync(input,JSON.stringify(doc));const created=call('put',input);
            fs.writeFileSync(input,JSON.stringify({...doc,id:created.id,expectedRevision:created.revision,body:'Updated packaged knowledge',change:'update'}));
            const updated=call('put',input);assert.equal(updated.id,created.id);
            assert.equal(call('read',created.id).body,'Updated packaged knowledge');
            assert.equal(call('search','Updated').total,1);
            assert.ok(fs.existsSync(path.join(data,'knowledge/.history',created.id,created.revision+'.md')));
            assert.equal(fs.existsSync(path.join(app,'knowledge')),false);
            console.log('PACKAGED_KNOWLEDGE_OK');
          })().catch(e=>{console.error(e);process.exitCode=1});
        `;
        const result = await run(process.execPath, ['-e', program, app], { cwd, env });
        assert.match(result.stdout, /PACKAGED_KNOWLEDGE_OK/);
        assert.equal(fs.existsSync(path.join(cwd, 'knowledge')), false);
      } finally {
        await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });
  }
});
