const fs = require('fs');
const files = ['package/dist/phonemizer.js', 'package/dist/phonemizer.cjs'];
for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  const target = 'new DecompressionStream("gzip")),f=[];for await(const A of e)f.push(A);';
  const replacement = 'new DecompressionStream("gzip"));const reader=e.getReader();f=[];for(;;){const{done,value}=await reader.read();if(done)break;f.push(value);}';
  if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(file, content, 'utf8');
    console.log(`Fixed ${file}`);
  } else {
    console.log(`Target not found in ${file}`);
  }
}
