// The boot: token → connect or shell, theme/density from the one local setting each (W12-04/05), and the hash router
// applied to `<crabby-shell>`'s outlet. Nothing here is a framework and nothing is built (D-068): the browser loads
// these files as they sit in the repository.
import "./js/screens/connect.js";
import "./js/screens/shell.js";
import "./js/screens/chat.js";
import "./js/screens/tasks.js";
import "./js/screens/approvals.js";
import "./js/screens/sessions.js";
import "./js/screens/jobs.js";
import "./js/screens/settings.js";
import { token } from "./js/api.js";

const theme = window.localStorage.getItem("crabby.theme");
if (theme !== null) document.documentElement.dataset.theme = theme;
const density = window.localStorage.getItem("crabby.density");
if (density !== null) document.documentElement.dataset.density = density;

const root = document.getElementById("app");
if (token() === undefined) {
  const el = document.createElement("crabby-connect");
  root.replaceChildren(el);
} else {
  const shell = document.createElement("crabby-shell");
  root.replaceChildren(shell);
  window.addEventListener("hashchange", () => {
    // A hash change inside the shell re-mounts the route; the element draws chrome from the store.
    shell.draw();
  });
}
