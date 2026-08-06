// A stand-in social feed used by the end-to-end test. It mimics the DOM shape
// the Instagram scraper reads (reel links + profile header) so the engine can
// be exercised without touching a real platform.
const http = require('http');

const CREATORS = [
  { username: 'alpha_creates', followers: '48.2K', bio: 'Business: alpha@alphastudio.com' },
  { username: 'beta_makes', followers: '1.2M', bio: 'huge account, no contact listed' },
  { username: 'gamma_films', followers: '15.7K', bio: 'collabs -> gamma.films@gmail.com' },
  { username: 'delta_tiny', followers: '900', bio: 'tiny account delta@delta.com' },
  { username: 'epsilon_co', followers: '88K', bio: 'press: hello@epsilon.co | noreply@mail.instagram.com' },
];

function feedPage() {
  return `<!doctype html><html><body>
<div id="feed"></div>
<video id="v"></video>
<script>
  const creators = ${JSON.stringify(CREATORS.map((c) => c.username))};
  let i = 0;
  function render() {
    document.getElementById('feed').innerHTML =
      '<a href="/' + creators[i] + '/reels/" style="display:block;height:40px;margin-top:50px">' +
      creators[i] + '</a>';
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { i = (i + 1) % creators.length; render(); }
  });
  render();
</script>
</body></html>`;
}

function profilePage(creator) {
  return `<!doctype html><html><head>
<meta name="description" content="${creator.followers} Followers, 300 Following - ${creator.username}">
</head><body>
<header><section>${creator.username}<br>${creator.bio}</section></header>
<main>
  <div>Suggested for you: otheruser — contact wrong-person@shouldnotbescraped.com</div>
</main>
</body></html>`;
}

function start(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/reels/' || url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(feedPage());
    }
    const m = url.pathname.match(/^\/([a-zA-Z0-9._]+)\/?$/);
    const creator = m && CREATORS.find((c) => c.username === m[1]);
    if (creator) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(profilePage(creator));
    }
    res.writeHead(404);
    res.end('nope');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { start, CREATORS };
