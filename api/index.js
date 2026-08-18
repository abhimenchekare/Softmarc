// Single Vercel Function for every /api/* route. The rewrite in vercel.json
// passes the requested suffix through `path`, then Express receives its
// original route (for example, /api/quizzes/1/questions).
const app = require('../server');

module.exports = (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.searchParams.get('path');

  if (path) {
    url.searchParams.delete('path');
    req.url = `/api/${path}${url.search}`;
  }

  return app(req, res);
};
