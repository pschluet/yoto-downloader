import { EventEmitter } from "node:events";

/** A minimal stand-in for a Node ChildProcess: emits data/error/close, nothing else. */
export type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};

export function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

export function writeStdout(child: FakeChild, text: string) {
  child.stdout.emit("data", Buffer.from(text));
}

export function writeStderr(child: FakeChild, text: string) {
  child.stderr.emit("data", Buffer.from(text));
}

export function closeWith(child: FakeChild, code: number | null) {
  child.emit("close", code);
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;

/**
 * Minimal ZIP central-directory reader, just enough to assert on entry
 * names in tests without pulling in a whole unzip dependency.
 */
export function listZipEntryNames(buf: Buffer): string[] {
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Not a valid zip: end-of-central-directory not found");

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16);

  const names: string[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error("Not a valid zip: bad central directory header");
    }
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.toString("utf8", offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
