// Dodaje do wersji web ikonę i ustawienia "Do ekranu początkowego" dla iPhone'a
const fs = require('fs');
const [file, base] = process.argv.slice(2);
let html = fs.readFileSync(file, 'utf8');
const tags = [
  `<link rel="apple-touch-icon" href="${base}/apple-touch-icon.png">`,
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="tradingjam">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black">',
  '<meta name="theme-color" content="#0b0f17">',
  '<style>html,body{background:#0b0f17}</style>',
].join('\n');
html = html.replace('</head>', tags + '\n</head>');
if (!/<title>/.test(html)) html = html.replace('</head>', '<title>tradingjam</title></head>');
else html = html.replace(/<title>[^<]*<\/title>/, '<title>tradingjam</title>');
fs.writeFileSync(file, html);
console.log('Dodano meta tagi do', file);
