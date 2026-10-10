// P4 fixture: the only thing the script is allowed to do is open the sheet and echo a submit locally, so the probe
// measures "does the document work before any framework exists", not "does React mount".
const more = document.getElementById("chip-more");
const sheet = document.getElementById("more-sheet");
more?.addEventListener("click", () => {
  const open = more.getAttribute("aria-expanded") === "true";
  more.setAttribute("aria-expanded", String(!open));
  if (sheet) sheet.hidden = open;
});
document.getElementById("composer")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const box = document.getElementById("transcript");
  const value = document.getElementById("input")?.value.trim();
  if (box && value) box.append(document.createTextNode(`${value}\n`));
});
