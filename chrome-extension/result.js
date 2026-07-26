const params = new URLSearchParams(location.search);
const ok = params.get("ok") === "1";
const title = params.get("title") || (ok ? "收录成功" : "收录失败");
const message = params.get("message") || "";

document.querySelector("#title").textContent = title;
document.querySelector("#title").className = ok ? "ok" : "err";
document.querySelector("#message").textContent = message;
document.querySelector("#close").addEventListener("click", () => window.close());

if (ok) {
  setTimeout(() => window.close(), 5000);
}
