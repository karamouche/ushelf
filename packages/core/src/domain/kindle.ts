import { z } from "zod";

export const kindleTargetSchema = z.object({
  targetSerial: z.string().trim().min(1).max(128),
});

export interface KindleDevice {
  name: string;
  serial: string;
}

export interface KindleDevices {
  devices: KindleDevice[];
  preferredTargetSerial?: string;
}

export interface KindleStatus {
  configured: boolean;
  accountName?: string;
  homeRegion?: string;
  error?: { code: string; message: string };
}

export interface KindleDeliveryResult {
  sku: string;
  itemId: string;
  revision: string;
  targetSerial: string;
}

export class KindleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KindleError";
  }
}
