// Refresh only the embedded artwork. The delivered game remains a standalone HTML file.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const target=new URL('rekenracev2/index.html',root);
const files={cars:'dieren-autootjes.webp',decor:'dorpsdecor.webp'};
const art=Object.fromEntries(Object.entries(files).map(([key,name])=>[key,'data:image/webp;base64,'+fs.readFileSync(new URL('rekenracev2/art/'+name,root)).toString('base64')]));
const source=fs.readFileSync(target,'utf8');
const pattern=/const ART = \{[^\n]+\};/;
if(!pattern.test(source))throw Error('Embedded artwork block not found');
const result=source.replace(pattern,'const ART = '+JSON.stringify(art)+';');
if(result!==source)fs.writeFileSync(target,result);
console.log('Rekenrace artwork is embedded in '+fileURLToPath(target));
