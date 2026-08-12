(() => {
  "use strict";
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const surfaces = {
    "/":["home","MATT ECOSYSTEM"],"/hub":["hub","HUB"],"/poker":["poker","POKER"],"/slots":["slots","SLOTS"],
    "/blackjack":["blackjack","BLACKJACK"],"/gift-boxes":["gift-boxes","GIFT BOXES"],
    "/liquidity":["liquidity","POOL MANAGER"],"/rock-paper-scissors":["rps","ROCK PAPER SCISSORS"]
  };
  const [surface,label] = surfaces[path] || ["ecosystem","MATT"];
  document.body.classList.add("matt-suite","matt-surface-"+surface);
  const links = [["/","HOME"],["/hub","HUB"],["/poker","POKER"],["/slots","SLOTS"],["/blackjack","BLACKJACK"],["/gift-boxes","BOXES"],["/liquidity","LIQUIDITY"]];
  const rail = document.createElement("div");
  rail.className = "matt-suite-rail";
  rail.innerHTML =
    '<a class="matt-suite-identity" href="/" aria-label="MATT home"><span class="matt-suite-mark" aria-hidden="true">M</span><span class="matt-suite-wordmark">MATT</span><span class="matt-suite-surface">/ '+label+'</span></a>'+
    '<nav class="matt-suite-nav" aria-label="MATT ecosystem">'+links.map(([href,text])=>'<a href="'+href+'"'+(path===href?' aria-current="page"':"")+'>'+text+'</a>').join("")+'</nav>'+
    '<span class="matt-suite-chain"><i></i>RONIN MAINNET</span>';
  document.body.prepend(rail);
  const footer = document.querySelector("footer");
  if(footer)footer.classList.add("matt-suite-footer");
  else{
    const injected=document.createElement("footer");
    injected.className="matt-suite-injected-footer";
    injected.innerHTML="<strong>MATT</strong><span>USE IT · PLAY IT · BUILD WITH IT</span><span>RONIN MAINNET</span>";
    document.body.append(injected);
  }
})();
