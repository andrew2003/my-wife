import { dkimVerify } from "mailauth";

/** `domain` is the signing domain (d=) of the first passing signature. */
export type DkimVerdict = { result: "pass" | "fail" | "none"; domain: string | null };

export type DkimVerifier = (raw: Buffer) => Promise<DkimVerdict>;

export type DnsResolver = (name: string, rr: string) => Promise<string[][]>;

/**
 * DKIM verification with mailauth. The resolver is injectable for dev and e2e;
 * only a `pass` is accepted, every other outcome (including DNS errors) is not.
 */
export function createMailauthVerifier(resolver?: DnsResolver): DkimVerifier {
  return async (raw) => {
    try {
      const { results } = await dkimVerify(raw, resolver ? { resolver } : {});
      if (results.length === 0) return { result: "none", domain: null };
      const passing = results.find((r) => r.status.result === "pass");
      if (passing) return { result: "pass", domain: String(passing.signingDomain).toLowerCase() };
      return { result: "fail", domain: null };
    } catch {
      return { result: "fail", domain: null };
    }
  };
}

/** The signing domain must be the mapped domain, and the From address must belong to it. */
export function domainAligned(
  signingDomain: string,
  fromAddress: string,
  mappedDomain?: string,
): boolean {
  const fromDomain = fromAddress.split("@").pop()?.toLowerCase() ?? "";
  const within = (d: string, parent: string) => d === parent || d.endsWith(`.${parent}`);
  if (mappedDomain && signingDomain !== mappedDomain.toLowerCase()) return false;
  return within(fromDomain, signingDomain);
}
