/** Pages the computer program's tests serve: DuckDuckGo-like results, and a page to browse. */

/** A result as DuckDuckGo's HTML page has it. */
const result = (href: string, title: string, snippet: string, ad = false) => `
  <div class="result results_links results_links_deep web-result ${ad ? "result--ad" : ""}">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="${href}">${title}</a>
      </h2>
      <div class="result__extras"><a class="result__url" href="${href}">site</a></div>
      <a class="result__snippet" href="${href}">${snippet}</a>
    </div>
  </div>`;

export const RESULTS = `<!doctype html><html><body><div id="links" class="results">
  ${result("https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=x", "An ad", "Buy", true)}
  ${
  result(
    "https://deno.com/",
    "Deno, the &amp; runtime",
    "A <b>runtime</b> with &quot;batteries&quot;",
  )
}
  ${
  result(
    "//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fabout%3Fa%3D1%26b%3D2&amp;rut=abc",
    "About Node.js&#x27;s   runtime",
    "Node&#39;s <b>event</b>\n loop",
  )
}
  ${result("https://bun.sh/", "Bun", "Fast")}
</div></body></html>`;

export const TURNED_AWAY =
  `<!doctype html><html><body><form id="challenge-form"><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></form></body></html>`;

/** A page to drive: a button that counts its clicks, a field, a link. */
export const PAGE = `<!doctype html><title>Engine fixture</title>
<style>body{margin:20px}button,input,a{display:block;margin:12px 0}#click{width:150px;height:40px}</style>
<h1>Engine fixture</h1>
<button id="click" onclick="this.textContent='Clicked '+(++window.clicks)">Press me</button>
<label>Name<input id="name" aria-label="Name"></label>
<p id="stored"></p>
<script>window.clicks=0;document.querySelector('#stored').textContent='stored: '+(localStorage.getItem('who')??'none');</script>`;
