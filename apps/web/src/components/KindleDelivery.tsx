import { useEffect, useRef, useState } from "react";
import {
  getKindleStatus,
  listKindleDevices,
  sendToKindle,
  type KindleDevice,
  type ShelfItem,
} from "../api.js";

export function KindleDelivery({ item }: { item: ShelfItem }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState<boolean>();
  const [devices, setDevices] = useState<KindleDevice[]>([]);
  const [targetSerial, setTargetSerial] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  const show = async () => {
    setOpen(true);
    setLoading(true);
    setConfigured(undefined);
    setDevices([]);
    setTargetSerial("");
    setError("");
    setSuccess("");
    try {
      const status = await getKindleStatus();
      setConfigured(status.configured);
      if (status.error) {
        setError(status.error.message);
        return;
      }
      if (!status.configured) return;
      const available = await listKindleDevices();
      setDevices(available.devices);
      setTargetSerial(
        available.preferredTargetSerial ??
          (available.devices.length === 1 ? available.devices[0]!.serial : ""),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const deliver = async () => {
    if (!targetSerial || sending) return;
    setSending(true);
    setError("");
    try {
      const result = await sendToKindle(item.id, targetSerial);
      setSuccess(`Accepted by Send to Kindle · ${result.sku}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button className="kindle-trigger" type="button" onClick={() => void show()}>
        Send to Kindle
      </button>
      <dialog
        ref={dialogRef}
        className="kindle-dialog"
        aria-labelledby="kindle-dialog-title"
        onClose={() => setOpen(false)}
        onCancel={(event) => {
          if (sending) event.preventDefault();
        }}
      >
        <button
          className="dialog-close"
          type="button"
          aria-label="Close Send to Kindle"
          onClick={() => setOpen(false)}
          disabled={sending}
        >
          ×
        </button>
        <p className="eyebrow">Device delivery</p>
        <h2 id="kindle-dialog-title">Send to Kindle</h2>
        <p className="dialog-copy">
          uShelf will send a reflowable EPUB containing the saved source and its images. It will not
          include insights or remain in your Amazon cloud library.
        </p>
        {loading ? <p role="status">Checking Kindle…</p> : null}
        {!loading && configured === false ? (
          <div className="kindle-setup">
            <p>Kindle is not configured. Run this command, then reopen this dialog:</p>
            <code>ushelf kindle setup</code>
          </div>
        ) : null}
        {!loading && configured && !error && !success ? (
          devices.length ? (
            <>
              <label className="kindle-device">
                <span>Kindle device</span>
                <select
                  value={targetSerial}
                  onChange={(event) => setTargetSerial(event.target.value)}
                  disabled={sending}
                >
                  <option value="">Choose a device</option>
                  {devices.map((device) => (
                    <option key={device.serial} value={device.serial}>
                      {device.name} · {maskKindleSerial(device.serial)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="kindle-submit"
                type="button"
                disabled={!targetSerial || sending}
                onClick={() => void deliver()}
              >
                {sending ? "Sending…" : "Send to this device"}
              </button>
            </>
          ) : (
            <p>No Kindle devices are registered with this Amazon account.</p>
          )
        ) : null}
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="dialog-success" role="status">
            {success}
          </p>
        ) : null}
      </dialog>
    </>
  );
}

function maskKindleSerial(value: string): string {
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
}
