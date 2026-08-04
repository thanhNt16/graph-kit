import { randomUUID } from "node:crypto";
import { GraphKitError } from "../errors.js";
import type { Lease } from "../schemas.js";

const DEFAULT_TTL_MS = 30_000;

export interface IssueRequest {
  work_item: string;
  node: string;
  now: number;
  ttlMs?: number;
}

export function issueLeases(items: IssueRequest[]): Lease[] {
  return items.map((item) => {
    const issuedAt = new Date(item.now).toISOString();
    const expiresAt = new Date(item.now + (item.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
    return {
      id: randomUUID(),
      work_item: item.work_item,
      node: item.node,
      issued_at: issuedAt,
      expires_at: expiresAt,
      status: "active",
    } as Lease;
  });
}

export interface ValidateInput {
  leases: Lease[];
  now: number;
  id: string;
  work_item: string;
}

export function validateLease(input: ValidateInput): Lease {
  const lease = input.leases.find((l) => l.id === input.id);
  if (!lease) throw new GraphKitError("LEASE_INVALID", "unknown lease");
  if (lease.work_item !== input.work_item)
    throw new GraphKitError("LEASE_INVALID", "lease bound to different work item");
  if (lease.status !== "active") throw new GraphKitError("LEASE_INVALID", "lease already settled");
  if (Date.parse(lease.expires_at) <= input.now) throw new GraphKitError("LEASE_EXPIRED", "lease expired");
  return lease;
}

export interface SettleInput {
  leases: Lease[];
  now: number;
  id: string;
}

export function settleLease(input: SettleInput): Lease {
  const lease = input.leases.find((l) => l.id === input.id);
  if (!lease) throw new GraphKitError("LEASE_INVALID", "unknown lease");
  if (lease.status !== "active") throw new GraphKitError("LEASE_INVALID", "lease already settled");
  if (Date.parse(lease.expires_at) <= input.now) throw new GraphKitError("LEASE_EXPIRED", "lease expired");
  lease.status = "settled";
  return lease;
}
