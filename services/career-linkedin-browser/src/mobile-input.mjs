export const KEY_SYMS = Object.freeze({
  backspace: 0xff08,
  tab: 0xff09,
  enter: 0xff0d,
});

export function codePointToKeysym(codePoint) {
  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    throw new Error("invalid_code_point");
  }
  if (codePoint <= 0xff) return codePoint;
  return 0x01000000 | codePoint;
}

export function sendTextToRfb(rfb, text) {
  for (const character of String(text)) {
    const keysym = codePointToKeysym(character.codePointAt(0));
    rfb.sendKey(keysym, null, true);
    rfb.sendKey(keysym, null, false);
  }
}

export function sendControlKeyToRfb(rfb, keysym) {
  rfb.sendKey(keysym, null, true);
  rfb.sendKey(keysym, null, false);
}
