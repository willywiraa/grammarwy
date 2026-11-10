/**
 * Copies text to the clipboard and returns true if it worked.
 *
 * It uses the modern Clipboard API when it can. Browsers only offer that API
 * on HTTPS pages and on localhost, so there is a fallback for other cases, for
 * example when you open the dev server on your phone over your home network.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // For example, the browser refused permission. Try the older way below.
    }
  }
  return copyWithHiddenTextArea(text);
}

/** The older way: select the text in a hidden text area and run the browser's copy command. */
function copyWithHiddenTextArea(text: string): boolean {
  const previousFocus = document.activeElement;

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", ""); // stops phones from opening the keyboard
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px"; // off-screen
  textArea.style.fontSize = "16px"; // stops iPhones from zooming in
  document.body.append(textArea);
  textArea.select();
  textArea.setSelectionRange(0, text.length); // needed on iPhones

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  textArea.remove();
  // Put the focus back, usually on the Copy button that was clicked.
  if (previousFocus instanceof HTMLElement) {
    previousFocus.focus();
  }
  return copied;
}
