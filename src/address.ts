/**
 * Address rendering for standard output scripts.
 *
 * The indexer needs addresses for one reason: the holdings endpoint answers
 * "which artifacts rest on outputs that pay this address". Bitcoin Core can
 * supply an address in its block JSON, but only for scripts it recognises and
 * only in some verbosity modes, so the indexer derives its own and treats
 * anything it does not recognise as having no address.
 *
 * Supported: P2PKH, P2SH, P2WPKH, P2WSH, P2TR and future segwit programs.
 * Everything else returns null, which is the correct answer rather than a guess.
 */

import { createHash } from 'node:crypto';
import type { Network } from './config.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function base58Encode(payload: Buffer): string {
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  const full = Buffer.concat([payload, checksum]);

  let zeros = 0;
  while (zeros < full.length && full[zeros] === 0) zeros += 1;

  const digits: number[] = [0];
  for (let i = zeros; i < full.length; i += 1) {
    let carry = full[i] as number;
    for (let j = 0; j < digits.length; j += 1) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += BASE58_ALPHABET[digits[i] as number];
  return out;
}

function bech32Polymod(values: readonly number[]): number {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >>> i) & 1) checksum ^= generator[i] as number;
    }
  }
  return checksum >>> 0;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data: readonly number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxValue = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxValue);
  } else if (bits >= from || ((acc << (to - bits)) & maxValue) !== 0) {
    return null;
  }
  return out;
}

function bech32Encode(hrp: string, data: readonly number[], constant: number): string {
  const values = [...bech32HrpExpand(hrp), ...data];
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ constant;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i += 1) checksum.push((polymod >> (5 * (5 - i))) & 31);
  let out = `${hrp}1`;
  for (const value of [...data, ...checksum]) out += BECH32_ALPHABET[value];
  return out;
}

interface NetworkPrefixes {
  readonly p2pkh: number;
  readonly p2sh: number;
  readonly hrp: string;
}

const PREFIXES: Record<Network, NetworkPrefixes> = {
  mainnet: { p2pkh: 0x00, p2sh: 0x05, hrp: 'bc' },
  signet: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'tb' },
  regtest: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'bcrt' },
};

/**
 * Render a scriptPubKey as an address for the given network.
 * Returns null for scripts with no standard address form.
 */
export function scriptToAddress(scriptHex: string, network: Network): string | null {
  if (typeof scriptHex !== 'string' || scriptHex.length === 0 || scriptHex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(scriptHex)) return null;
  const script = Buffer.from(scriptHex, 'hex');
  const prefixes = PREFIXES[network];

  // P2PKH: OP_DUP OP_HASH160 PUSH20 <hash> OP_EQUALVERIFY OP_CHECKSIG
  if (
    script.length === 25 &&
    script[0] === 0x76 &&
    script[1] === 0xa9 &&
    script[2] === 0x14 &&
    script[23] === 0x88 &&
    script[24] === 0xac
  ) {
    return base58Encode(Buffer.concat([Buffer.from([prefixes.p2pkh]), script.subarray(3, 23)]));
  }

  // P2SH: OP_HASH160 PUSH20 <hash> OP_EQUAL
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return base58Encode(Buffer.concat([Buffer.from([prefixes.p2sh]), script.subarray(2, 22)]));
  }

  // Segwit: version opcode, then a single push of 2 to 40 bytes.
  const first = script[0] as number;
  const isVersionZero = first === 0x00;
  const isVersionN = first >= 0x51 && first <= 0x60;
  if ((isVersionZero || isVersionN) && script.length >= 4) {
    const version = isVersionZero ? 0 : first - 0x50;
    const pushLength = script[1] as number;
    if (pushLength >= 2 && pushLength <= 40 && script.length === pushLength + 2) {
      if (version === 0 && pushLength !== 20 && pushLength !== 32) return null;
      const program = [...script.subarray(2)];
      const words = convertBits(program, 8, 5, true);
      if (words === null) return null;
      const constant = version === 0 ? 1 : 0x2bc830a3;
      return bech32Encode(prefixes.hrp, [version, ...words], constant);
    }
  }

  return null;
}
