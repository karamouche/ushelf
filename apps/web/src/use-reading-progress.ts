import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getItem, updateReading, type ReadingStatus, type ShelfItem } from "./api.js";

const IDLE_SAVE_DELAY_MS = 750;
const MAX_SAVE_INTERVAL_MS = 4000;
const MINIMUM_PROGRESS_CHANGE = 0.005;

interface PendingReadingUpdate {
  progress: number;
  status: ReadingStatus;
  explicitStatus: boolean;
}

interface ReadingUpdate {
  progress: number;
  status: ReadingStatus;
}

interface FlushOptions {
  keepalive?: boolean;
}

interface ReadingProgressController {
  liveProgress: number;
  saveError: string;
  changeStatus: (status: ReadingStatus) => Promise<void>;
  flush: (options?: FlushOptions) => Promise<void>;
}

export function useReadingProgress(
  item: ShelfItem | undefined,
  setItem: Dispatch<SetStateAction<ShelfItem | undefined>>,
): ReadingProgressController {
  const [liveProgress, setLiveProgress] = useState(0);
  const [saveError, setSaveError] = useState("");
  const itemRef = useRef(item);
  const liveProgressRef = useRef(0);
  const pendingRef = useRef<PendingReadingUpdate | undefined>(undefined);
  const drainRef = useRef<Promise<void> | undefined>(undefined);
  const idleTimerRef = useRef<number | undefined>(undefined);
  const maxTimerRef = useRef<number | undefined>(undefined);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const suppressScrollRef = useRef(false);
  const mountedRef = useRef(true);
  const keepaliveRef = useRef(false);

  useEffect(() => {
    itemRef.current = item;
  }, [item]);

  const applyItem = useCallback(
    (next: ShelfItem) => {
      itemRef.current = next;
      if (mountedRef.current) setItem(next);
    },
    [setItem],
  );

  const clearSaveTimers = useCallback(() => {
    if (idleTimerRef.current !== undefined) window.clearTimeout(idleTimerRef.current);
    if (maxTimerRef.current !== undefined) window.clearTimeout(maxTimerRef.current);
    idleTimerRef.current = undefined;
    maxTimerRef.current = undefined;
  }, []);

  const drain = useCallback(async () => {
    if (drainRef.current) return drainRef.current;

    const running = (async () => {
      while (pendingRef.current) {
        const pending = pendingRef.current;
        pendingRef.current = undefined;
        let current = itemRef.current;
        if (!current) continue;

        const update = readingUpdateFor(
          current.reading.status,
          current.reading.progress,
          pending.status,
          pending.progress,
          pending.explicitStatus,
        );
        if (!update) continue;

        try {
          const next = await updateReading(current, update.status, update.progress, {
            keepalive: keepaliveRef.current,
          });
          applyItem(next);
          if (mountedRef.current) setSaveError("");
        } catch (reason) {
          if (!isStaleWrite(reason)) {
            pendingRef.current = undefined;
            if (mountedRef.current) setSaveError(readingSaveError(reason));
            break;
          }

          try {
            current = await getItem(current.id);
            applyItem(current);
            const retryUpdate = readingUpdateFor(
              current.reading.status,
              current.reading.progress,
              pending.status,
              pending.progress,
              pending.explicitStatus,
            );
            if (!retryUpdate) {
              if (current.reading.status !== "read") continue;
              liveProgressRef.current = 1;
              if (mountedRef.current) setLiveProgress(1);
              continue;
            }
            const next = await updateReading(current, retryUpdate.status, retryUpdate.progress, {
              keepalive: keepaliveRef.current,
            });
            applyItem(next);
            if (mountedRef.current) setSaveError("");
          } catch (retryReason) {
            pendingRef.current = undefined;
            if (mountedRef.current) setSaveError(readingSaveError(retryReason));
            break;
          }
        }
      }
    })().finally(() => {
      drainRef.current = undefined;
      keepaliveRef.current = false;
    });

    drainRef.current = running;
    return running;
  }, [applyItem]);

  const flush = useCallback(
    async (options?: FlushOptions) => {
      clearSaveTimers();
      keepaliveRef.current ||= options?.keepalive === true;
      await drain();
    },
    [clearSaveTimers, drain],
  );

  const scheduleSave = useCallback(() => {
    if (idleTimerRef.current !== undefined) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => void flush(), IDLE_SAVE_DELAY_MS);
    maxTimerRef.current ??= window.setTimeout(() => void flush(), MAX_SAVE_INTERVAL_MS);
  }, [flush]);

  useEffect(() => {
    if (!item) return;
    itemRef.current = item;
    const initialProgress = item.reading.status === "read" ? 1 : item.reading.progress;
    liveProgressRef.current = initialProgress;
    setLiveProgress(initialProgress);
    pendingRef.current = undefined;
    clearSaveTimers();
    suppressScrollRef.current = true;

    const restoreTimer = window.setTimeout(() => {
      window.scrollTo({
        top:
          initialProgress * Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
        behavior: "instant",
      });
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          suppressScrollRef.current = false;
        }),
      );
    }, 80);

    const onScroll = () => {
      if (suppressScrollRef.current || animationFrameRef.current !== undefined) return;
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = undefined;
        const current = itemRef.current;
        if (!current || current.reading.status === "read") return;
        const progress = calculateReadingProgress(
          window.scrollY,
          document.documentElement.scrollHeight,
          window.innerHeight,
        );
        liveProgressRef.current = progress;
        setLiveProgress(progress);
        pendingRef.current = {
          status: current.reading.status === "inbox" ? "reading" : current.reading.status,
          progress,
          explicitStatus: false,
        };
        scheduleSave();
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") void flush({ keepalive: true });
    };
    const onPageHide = () => void flush({ keepalive: true });

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(restoreTimer);
      if (animationFrameRef.current !== undefined)
        window.cancelAnimationFrame(animationFrameRef.current);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void flush({ keepalive: true });
    };
  }, [clearSaveTimers, flush, item?.id, scheduleSave]);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const changeStatus = useCallback(
    async (status: ReadingStatus) => {
      const current = itemRef.current;
      if (!current) return;
      const progress = status === "read" ? 1 : liveProgressRef.current;
      if (status === "read") {
        liveProgressRef.current = 1;
        setLiveProgress(1);
      }
      pendingRef.current = { status, progress, explicitStatus: true };
      await flush();
    },
    [flush],
  );

  return { liveProgress, saveError, changeStatus, flush };
}

function isStaleWrite(reason: unknown): boolean {
  return reason instanceof Error && /changed since it was read/i.test(reason.message);
}

export function calculateReadingProgress(
  scrollY: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  const denominator = scrollHeight - viewportHeight;
  return Math.max(0, Math.min(1, denominator > 0 ? scrollY / denominator : 1));
}

export function readingUpdateFor(
  currentStatus: ReadingStatus,
  currentProgress: number,
  requestedStatus: ReadingStatus,
  requestedProgress: number,
  explicitStatus: boolean,
): ReadingUpdate | undefined {
  if (!explicitStatus && currentStatus === "read") return undefined;
  const status = explicitStatus
    ? requestedStatus
    : currentStatus === "inbox"
      ? "reading"
      : currentStatus;
  const progress = status === "read" ? 1 : Math.max(0, Math.min(1, requestedProgress));
  if (status === currentStatus && Math.abs(progress - currentProgress) < MINIMUM_PROGRESS_CHANGE)
    return undefined;
  return { status, progress };
}

function readingSaveError(reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return `Reading position could not be saved. ${detail}`;
}
