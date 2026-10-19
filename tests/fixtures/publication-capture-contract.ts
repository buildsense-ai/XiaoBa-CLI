// Test-only fixture. Creates no connection, credential, publication or model call.
import * as fs from 'fs';
import * as path from 'path';
import { createCatsCoLocalConfigService } from '../../src/catscompany/local-config';
import { BotSkillWorkspaceService } from '../../src/bot-skills/workspace';
import { PublicationCaptureStore } from '../../src/skillhub/publication-capture';
import { describePublicationSource } from '../../src/skillhub/publication-source';

async function main() {
  const root=process.argv[2];if(!root||fs.readdirSync(root).length)throw Error('Empty fixture-owned directory required');
  const skills=path.join(root,'skills'),source=path.join(skills,'fixture');fs.mkdirSync(source,{recursive:true});
  new BotSkillWorkspaceService(root,skills).activate('42');
  const binding={botUid:'42',ownerUid:'7',bodyId:'contract-body',installationId:'contract-install'};
  createCatsCoLocalConfigService({runtimeRoot:root}).save({version:1,currentBot:{uid:'42',apiKey:'test',boundByUserUid:'7'},
    account:{uid:'7',username:'fixture',token:'test'},device:{bodyId:binding.bodyId,installationId:binding.installationId}});
  const examples=[['valid','---\nname: fixture\ndescription: Capture contract\n---\nHello'],
    ['invalid','---\nname: [broken YAML\n---\n'],['script','---js\nthrow new Error("never run")\n---\n']];
  const outputs=[];
  for(const [index,[kind,content]] of examples.entries()){
    fs.writeFileSync(path.join(source,'SKILL.md'),content);
    fs.writeFileSync(path.join(source,'图片.bin'),Buffer.from([0,255,128,13,10]));
    const input={entryId:'pubentry_'+index.toString(16).padStart(32,'0'),binding,source:describePublicationSource(skills,source,binding)};
    const capture=new PublicationCaptureStore({runtimeRoot:root,enabled:true});
    const receipt=await capture.capture(input,()=>{});
    const bytes=await new PublicationCaptureStore({runtimeRoot:root,enabled:true}).readRequest(input,()=>{});
    outputs.push({kind,receipt,request:bytes.toString('utf8')});
  }
  process.stdout.write(JSON.stringify(outputs));
}
main().catch(()=>{process.stderr.write('Capture contract fixture failed\n');process.exitCode=1;});
