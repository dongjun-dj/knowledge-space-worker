(() => {
  const selection = window.getSelection?.().toString() || "";
  return selection.trim();
})();
