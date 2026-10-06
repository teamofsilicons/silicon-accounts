/* Silicon Accounts theme boot: applies the stored or system theme before the first paint.
   Kept tiny and dependency-free; the app's theme manager (src/theme/theme.ts) owns it afterwards. */
(function () {
  var root = document.documentElement;
  var preference = "system";
  try {
    var stored = window.localStorage.getItem("silicon-accounts.theme");
    if (stored === "light" || stored === "dark" || stored === "system") preference = stored;
  } catch (error) {
    /* Storage can be blocked (private mode, disabled site data); the system theme still applies. */
  }
  var dark = preference === "dark" ||
    (preference === "system" && !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.setAttribute("data-theme-preference", preference);
  root.style.colorScheme = dark ? "dark" : "light";
})();
