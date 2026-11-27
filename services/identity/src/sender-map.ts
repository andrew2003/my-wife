/** One bank sender and the DKIM domain its mail must be signed with (spec 50 section 2). */
export type SenderMapEntry = {
  senderKey: string;
  senderAddress: string;
  dkimDomain: string;
};

/** The global sender map curated by admins; in memory until the Drizzle store lands. */
export interface SenderMapStore {
  find(senderKey: string): Promise<SenderMapEntry | undefined>;
  save(entry: SenderMapEntry): Promise<void>;
  remove(senderKey: string): Promise<void>;
  list(): Promise<SenderMapEntry[]>;
}

export function createSenderMapStore(): SenderMapStore {
  const entries = new Map<string, SenderMapEntry>();
  return {
    async find(key) {
      const e = entries.get(key);
      return e && { ...e };
    },
    async save(entry) {
      entries.set(entry.senderKey, { ...entry });
    },
    async remove(key) {
      entries.delete(key);
    },
    async list() {
      return [...entries.values()].map((e) => ({ ...e }));
    },
  };
}
