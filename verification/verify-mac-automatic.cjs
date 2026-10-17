// Runs only on disposable macOS CI runners against the public Mac release.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {_electron:electron,expect}=require('@playwright/test'),asar=require('@electron/asar');
const version=process.env.RELEASE_VERSION,previous=process.env.PREVIOUS_VERSION,arch=process.arch;
if(process.platform!=='darwin'||!process.env.CI||![version,previous].every(v=>/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(v||'')))throw Error('This verification requires a disposable native Mac CI runner and explicit versions.');
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',maxBuffer:8e6});
const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'versehalo-live-update-')),name='VerseHalo-Mac-'+version+'-'+arch+'.zip';
let app;
(async()=>{
 const release=JSON.parse(run('gh',['api','repos/Benighter/VerseHalo-Releases/releases/tags/mac-v'+version]));assert.equal(release.draft,false);
 const asset=release.assets.find(a=>a.name===name);assert(asset&&/^sha256:[a-f0-9]{64}$/.test(asset.digest));
 run('gh',['release','download','mac-v'+version,'--repo','Benighter/VerseHalo-Releases','--pattern',name,'--dir',root]);
 const zip=path.join(root,name),hash=crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');assert.equal('sha256:'+hash,asset.digest);assert.equal(fs.statSync(zip).size,asset.size);
 const unpack=path.join(root,'installed');fs.mkdirSync(unpack);run('/usr/bin/ditto',['-x','-k',zip,unpack]);
 const bundle=path.join(unpack,'VerseHalo.app'),plist=path.join(bundle,'Contents','Info.plist'),archive=path.join(bundle,'Contents','Resources','app.asar'),content=path.join(root,'app-content');
 const pub=run('/usr/bin/plutil',['-extract','SUPublicEDKey','raw','-o','-',plist]).trim(),feedURL=run('/usr/bin/plutil',['-extract','SUFeedURL','raw','-o','-',plist]).trim();
 assert.equal(pub,'tb/ZJawKd6xH/B76jt5sFtnRK8bUUnGVKGrJodXPjd8=');assert.equal(feedURL,'https://github.com/Benighter/VerseHalo-Releases/releases/download/mac-update-channel/mac-'+arch+'.xml');
 const response=await fetch(feedURL);assert.equal(response.status,200);const feed=Buffer.from(await response.arrayBuffer()),marker=Buffer.from('<!-- sparkle-signatures:\n'),at=feed.lastIndexOf(marker);assert(at>0);const body=feed.subarray(0,at),signature=feed.subarray(at+marker.length).toString().match(/^edSignature: ([A-Za-z0-9+/]{86}==)\nlength: (\d+)\n-->\s*$/);assert(signature);assert.equal(Number(signature[2]),body.length);
 const key=crypto.createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(pub,'base64')])});assert(crypto.verify(null,body,key,Buffer.from(signature[1],'base64')));assert(body.toString().includes('<sparkle:shortVersionString>'+version+'</sparkle:shortVersionString>'));
 // Produce an older-version fixture with the release's exact updater and production key.
 asar.extractAll(archive,content);const packageFile=path.join(content,'package.json'),pkg=JSON.parse(fs.readFileSync(packageFile));assert.equal(pkg.version,version);pkg.version=previous;fs.writeFileSync(packageFile,JSON.stringify(pkg));
 const changed=path.join(root,'app.asar');await asar.createPackage(content,changed);const integrity=crypto.createHash('sha256').update(asar.getRawHeader(changed).headerString).digest('hex');fs.copyFileSync(changed,archive);
 run('python3',['-c','import plistlib,sys\np=sys.argv[1]\nwith open(p,"rb") as f: d=plistlib.load(f)\nd["CFBundleShortVersionString"]=sys.argv[2]\nd["CFBundleVersion"]=sys.argv[2].replace("-beta.","b")\nd.setdefault("ElectronAsarIntegrity",{})["Resources/app.asar"]={"algorithm":"SHA256","hash":sys.argv[3]}\nwith open(p,"wb") as f: plistlib.dump(d,f)',plist,previous,integrity]);
 run('/usr/bin/codesign',['--force','--sign','-',bundle]);run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
 const data=path.join(os.homedir(),'Library','Application Support','VerseHalo');assert(!fs.existsSync(data),'Fresh runner must not have existing VerseHalo user data.');fs.mkdirSync(path.join(data,'media'),{recursive:true});
 const core=require(path.join(content,'src','core.cjs')),workspace=core.initialWorkspace(),mediaId=core.id(),mediaFile=path.join(data,'media',mediaId+'.png');fs.copyFileSync(path.join(content,'assets','icon.png'),mediaFile);const mediaHash=crypto.createHash('sha256').update(fs.readFileSync(mediaFile)).digest('hex');
 workspace.programName='Native automatic discovery fixture';workspace.media=[{id:mediaId,kind:'image',title:'Preserved fixture',file:mediaFile,folder:'Library'}];workspace.songs=[{id:core.id(),title:'Preserved fixture song',slides:core.splitLyrics('Preserved words')}];workspace.program=[{id:core.id(),kind:'image',title:'Preserved program',slides:[{id:core.id(),kind:'image',mediaId}]}];fs.writeFileSync(path.join(data,'workspace.json'),JSON.stringify(workspace));
 const env={...process.env};for(const key of ['VERSEHALO_QA','VERSEHALO_QA_DATA','VERSEHALO_QA_UPDATE_FEED','ELECTRON_RUN_AS_NODE','GH_TOKEN','GITHUB_TOKEN'])delete env[key];const started=Date.now();
 app=await electron.launch({executablePath:path.join(bundle,'Contents','MacOS','VerseHalo'),args:[],env});const page=await app.firstWindow();await expect(page.locator('#program-name')).toHaveValue(workspace.programName,{timeout:60000});
 assert.equal(await app.evaluate(({app})=>app.getPath('userData')),data);assert.equal(await app.evaluate(({app})=>app.getVersion()),previous);
 // No updates:check request, QA flag, forced timer, feed redirect or updater method call.
 await expect.poll(()=>page.locator('#toast').textContent(),{timeout:90000,intervals:[250,1000]}).toContain('Version '+version+' is available');
 const state=await page.evaluate(()=>window.versehalo.request('init'));assert.equal(state.workspace.programName,workspace.programName);assert.equal(state.workspace.program.length,1);assert.equal(state.workspace.songs.length,1);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(mediaFile)).digest('hex'),mediaHash);assert.equal(fs.existsSync(path.join(data,'Updates')),false);
 const report={arch,success:true,nativeAutomaticDiscovery:true,qaMode:false,manuallyRequestedCheck:false,clockForced:false,productionPublicFeed:feedURL,feedSignatureVerified:true,sourceArchiveSha256:hash,fixtureVersion:previous,availableVersion:version,bootstrapFixture:true,fixtureDescription:'Public current app repackaged with an older version number; updater code and production key unchanged. Not the original public beta.2.',millisecondsToNotice:Date.now()-started,workspacePreserved:true,mediaSha256:mediaHash,noUnconfirmedDownloadOrInstall:true,installCycleEvidence:'The separate native build verification records cover signed replacement, rejection and relaunch.',systemProtectionsDisabled:false};
 fs.writeFileSync(path.join(process.env.RUNNER_TEMP,'automatic-discovery-'+arch+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(async()=>{if(app)await app.close().catch(()=>{});});
