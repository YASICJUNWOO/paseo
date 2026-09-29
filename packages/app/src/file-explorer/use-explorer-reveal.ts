import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useToast } from "@/contexts/toast-context";
import type { ExpandedPathsUpdate } from "@/stores/panel-store";
import type { ExplorerDirectory } from "@/stores/session-store";
import {
  buildExplorerRevealKey,
  findExplorerListRowIndex,
  isExplorerRevealRequestExpired,
  planExplorerReveal,
  runExplorerReveal,
  type ExplorerRevealOutcome,
  type ExplorerRevealPlan,
  type ExplorerRevealRequest,
} from "./reveal";
import { useExplorerRevealStore } from "./reveal-store";
import { setExpandedDirectoryPath, type ExplorerListRow } from "./tree";

const REVEAL_VIEW_POSITION = 0.5;
/** Longest a reveal keeps steering the tree's scroll, however much the list is still rendering. */
export const SCROLL_CONVERGENCE_BUDGET_MS = 8_000;
/**
 * How long the list must go without progress (a new layout, content size, or measured row)
 * before the reveal centers one last time and stops. RN's VirtualizedList renders a
 * `maxToRenderPerBatch` batch every 60-100 ms, so this spans several batches.
 */
export const SCROLL_STALL_WINDOW_MS = 750;

/** The slice of `FlatList` the reveal drives. */
export interface ExplorerRevealScroller {
  scrollToIndex: (params: {
    index: number;
    viewPosition?: number;
    viewOffset?: number;
    animated?: boolean;
  }) => void;
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
}

export interface ScrollToIndexFailedInfo {
  index: number;
  averageItemLength: number;
  /** The last row index the list has actually measured; the render frontier. */
  highestMeasuredFrameIndex: number;
}

type RequestDirectoryListing = (
  path: string,
  opts?: { recordHistory?: boolean; setCurrentPath?: boolean },
) => Promise<ExplorerDirectory | null>;

type SetExpandedPathsForWorkspace = (workspaceStateKey: string, paths: ExpandedPathsUpdate) => void;

interface UseExplorerRevealInput {
  serverId: string;
  workspaceStateKey: string | null;
  directories: ReadonlyMap<string, ExplorerDirectory>;
  showHiddenFiles: boolean;
  listRows: readonly ExplorerListRow[];
  treeListRef: RefObject<ExplorerRevealScroller | null>;
  requestDirectoryListing: RequestDirectoryListing;
  setExpandedPathsForWorkspace: SetExpandedPathsForWorkspace;
  selectExplorerEntry: (path: string | null) => void;
  /**
   * True once the tree's own restore of persisted expanded folders has finished. That restore
   * rewrites the expanded set when it lands, so a reveal that ran alongside it would lose its
   * expansions.
   */
  isTreeRestored: boolean;
}

/** Wire each to the tree `FlatList`'s prop of the same name. */
interface UseExplorerRevealResult {
  onScrollToIndexFailed: (info: ScrollToIndexFailedInfo) => void;
  onListLayout: (event: LayoutChangeEvent) => void;
  onListScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onListContentSizeChange: (width: number, height: number) => void;
}

interface FinishedReveal {
  outcome: Exclude<ExplorerRevealOutcome, "superseded">;
  plan: ExplorerRevealPlan;
  request: ExplorerRevealRequest;
}

async function runRevealRequest(input: {
  revealKey: string;
  workspaceStateKey: string;
  request: ExplorerRevealRequest;
  directories: ReadonlyMap<string, ExplorerDirectory>;
  showHiddenFiles: boolean;
  requestDirectoryListing: RequestDirectoryListing;
  setExpandedPathsForWorkspace: SetExpandedPathsForWorkspace;
}): Promise<FinishedReveal | null> {
  const { revealKey, workspaceStateKey, request } = input;
  const plan = planExplorerReveal({ path: request.path, showHiddenFiles: input.showHiddenFiles });
  const outcome = await runExplorerReveal({
    plan,
    getDirectory: (path) => input.directories.get(path),
    requestDirectoryListing: (path) =>
      input.requestDirectoryListing(path, { recordHistory: false, setCurrentPath: false }),
    expandDirectory: (path) =>
      input.setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
        setExpandedDirectoryPath({
          currentExpandedPaths: currentPaths,
          directoryPath: path,
          expanded: true,
        }),
      ),
    isCurrent: () =>
      useExplorerRevealStore.getState().requests[revealKey]?.requestId === request.requestId,
  });
  if (outcome === "superseded") {
    return null;
  }
  useExplorerRevealStore
    .getState()
    .completeReveal({ key: revealKey, requestId: request.requestId });
  return { outcome, plan, request };
}

function clearPendingReveal(revealKey: string): void {
  const store = useExplorerRevealStore.getState();
  const pending = store.requests[revealKey];
  if (pending) {
    store.completeReveal({ key: revealKey, requestId: pending.requestId });
  }
}

interface ScrollAttempt {
  path: string;
  startedAt: number;
  /** Highest row index the list had measured at the last failed `scrollToIndex`. */
  frontier: number;
  /** Set for the closing centering pass, so a failure there ends the attempt instead of jumping. */
  isSettling: boolean;
}

interface RevealScroll {
  scrollTo: (path: string) => void;
  cancel: () => void;
  onScrollToIndexFailed: (info: ScrollToIndexFailedInfo) => void;
  onListLayout: (event: LayoutChangeEvent) => void;
  onListScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onListContentSizeChange: (width: number, height: number) => void;
}

/** The tree's viewport height, and the one the list last cached for its own centering math. */
interface ViewportLengths {
  /** Last non-zero layout height; 0 until the tree has been laid out visible. */
  real: number;
  /** What `VirtualizedList` last read from a layout or scroll event, zero included. */
  seenByList: number;
}

/**
 * `scrollToIndex` centers against the viewport length the list cached from its last layout or
 * scroll event. A retained tree keeps what hiding it reported (a zero-height scroll event on iOS),
 * and showing it again at the same size fires no layout, so the first centering would land the
 * row near the top and a later pass would glide it back. The offset shifts the target by the
 * difference, so the first scroll already goes to center.
 */
function staleViewportOffset(viewport: ViewportLengths): number {
  if (viewport.real <= 0) {
    return 0;
  }
  return REVEAL_VIEW_POSITION * (viewport.real - viewport.seenByList);
}

/** Where to jump for a row past the measured frontier: its estimated offset, already centered. */
function estimatedCenteredOffset(info: ScrollToIndexFailedInfo, viewport: ViewportLengths): number {
  const rowOffset = info.averageItemLength * info.index;
  const centering = REVEAL_VIEW_POSITION * Math.max(0, viewport.real - info.averageItemLength);
  return Math.max(0, rowOffset - centering);
}

/**
 * Drives the tree's scroll for a reveal in progress. One `scrollToIndex` is never enough: the
 * list's centering math uses its measured viewport (zero while the tree was `display: none`),
 * its cached row frames (stale after an expansion moved the rows), and its content height (which
 * clamps the offset while later rows are still unrendered). None of those settle in a known
 * number of frames, so the attempt stays alive and re-centers every time the list reports
 * progress, then centers once more after the list has been quiet for `SCROLL_STALL_WINDOW_MS`
 * and stops. The rows' index is re-read on every step, so a collapse ends the attempt.
 */
function useRevealScroll(input: {
  listRows: readonly ExplorerListRow[];
  treeListRef: RefObject<ExplorerRevealScroller | null>;
}): RevealScroll {
  const { listRows, treeListRef } = input;
  // The first step waits for the render that commits the reveal's expanded rows.
  const [startedAttempt, setStartedAttempt] = useState<ScrollAttempt | null>(null);
  const listRowsRef = useRef(listRows);
  const attemptRef = useRef<ScrollAttempt | null>(null);
  const frameRef = useRef<number | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRef = useRef<ViewportLengths>({ real: 0, seenByList: 0 });

  useEffect(() => {
    listRowsRef.current = listRows;
  }, [listRows]);

  const cancel = useCallback(() => {
    attemptRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (stallTimerRef.current !== null) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  // Unmounting mid-attempt must not leave a frame or timer running against a torn-down scroller.
  useEffect(() => cancel, [cancel]);

  const center = useCallback(
    (attempt: ScrollAttempt) => {
      if (attemptRef.current !== attempt) {
        return;
      }
      const index = findExplorerListRowIndex(listRowsRef.current, attempt.path);
      if (index < 0 || Date.now() - attempt.startedAt > SCROLL_CONVERGENCE_BUDGET_MS) {
        cancel();
        return;
      }
      treeListRef.current?.scrollToIndex({
        index,
        viewPosition: REVEAL_VIEW_POSITION,
        viewOffset: staleViewportOffset(viewportRef.current),
        animated: true,
      });
    },
    [cancel, treeListRef],
  );

  const scheduleCenter = useCallback(
    (attempt: ScrollAttempt) => {
      if (frameRef.current !== null) {
        return;
      }
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        center(attempt);
      });
    },
    [center],
  );

  const restartStallWindow = useCallback(
    (attempt: ScrollAttempt) => {
      if (stallTimerRef.current !== null) {
        clearTimeout(stallTimerRef.current);
      }
      stallTimerRef.current = setTimeout(() => {
        stallTimerRef.current = null;
        if (attemptRef.current !== attempt) {
          return;
        }
        attempt.isSettling = true;
        center(attempt);
        cancel();
      }, SCROLL_STALL_WINDOW_MS);
    },
    [cancel, center],
  );

  const onProgress = useCallback(() => {
    const attempt = attemptRef.current;
    if (!attempt || attempt.isSettling) {
      return;
    }
    restartStallWindow(attempt);
    // Next frame, so the row frames measured in this same layout pass are in place first.
    scheduleCenter(attempt);
  }, [restartStallWindow, scheduleCenter]);

  const scrollTo = useCallback(
    (path: string) => {
      cancel();
      const attempt = { path, startedAt: Date.now(), frontier: -1, isSettling: false };
      attemptRef.current = attempt;
      setStartedAttempt(attempt);
    },
    [cancel],
  );

  useEffect(() => {
    if (!startedAttempt || attemptRef.current !== startedAttempt) {
      return;
    }
    restartStallWindow(startedAttempt);
    center(startedAttempt);
  }, [center, restartStallWindow, startedAttempt]);

  // A row past the list's measured frontier has no frame yet. Jump to its estimated centered
  // offset so the list renders there, and retry next frame. A frontier that moved counts as
  // progress. The jump is centered so the row first appears near center, not at the top.
  const onScrollToIndexFailed = useCallback(
    (info: ScrollToIndexFailedInfo) => {
      const attempt = attemptRef.current;
      if (!attempt || attempt.isSettling) {
        return;
      }
      if (info.highestMeasuredFrameIndex > attempt.frontier) {
        attempt.frontier = info.highestMeasuredFrameIndex;
        restartStallWindow(attempt);
      }
      treeListRef.current?.scrollToOffset({
        offset: estimatedCenteredOffset(info, viewportRef.current),
        animated: false,
      });
      scheduleCenter(attempt);
    },
    [restartStallWindow, scheduleCenter, treeListRef],
  );

  const onListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      // `display: none` reports a zero viewport; only a real one can fix the centering math.
      viewportRef.current = {
        real: height > 0 ? height : viewportRef.current.real,
        seenByList: height,
      };
      if (height > 0) {
        onProgress();
      }
    },
    [onProgress],
  );

  // Not progress: the reveal's own scrolls fire these. It only tracks what the list cached.
  const onListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    viewportRef.current = {
      ...viewportRef.current,
      seenByList: event.nativeEvent.layoutMeasurement.height,
    };
  }, []);

  return useMemo(
    () => ({
      scrollTo,
      cancel,
      onScrollToIndexFailed,
      onListLayout,
      onListScroll,
      onListContentSizeChange: onProgress,
    }),
    [cancel, onListLayout, onListScroll, onProgress, onScrollToIndexFailed, scrollTo],
  );
}

/**
 * Tracks whether this tree can still finish a reveal. Going from visible to hidden abandons the
 * workspace's pending or in-flight request, so it neither moves the tree later nor replays.
 */
function useRevealLiveness(input: {
  isActive: boolean;
  revealKey: string | null;
  onAbandon: () => void;
}): RefObject<boolean> {
  const { isActive, revealKey, onAbandon } = input;
  const isLiveRef = useRef(isActive);
  const wasActiveRef = useRef(isActive);

  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;
    isLiveRef.current = isActive;
    if (wasActive && !isActive && revealKey) {
      clearPendingReveal(revealKey);
      onAbandon();
    }
  }, [isActive, onAbandon, revealKey]);

  useEffect(() => {
    isLiveRef.current = wasActiveRef.current;
    return () => {
      isLiveRef.current = false;
    };
  }, []);

  return isLiveRef;
}

/**
 * Finishes Reveal in Files requests for this tree. A request waits until the tree is visible, has
 * its root, and has restored its persisted expanded folders, so it survives the Explorer mounting
 * after the action fired. The lifecycle rules live on `useExplorerRevealStore`.
 */
export function useExplorerReveal(input: UseExplorerRevealInput): UseExplorerRevealResult {
  const { t } = useTranslation();
  const toast = useToast();
  const isActive = useRetainedPanelActive();
  const { serverId, workspaceStateKey, directories, showHiddenFiles } = input;
  const { requestDirectoryListing, setExpandedPathsForWorkspace, selectExplorerEntry } = input;
  const revealKey = workspaceStateKey
    ? buildExplorerRevealKey({ serverId, workspaceStateKey })
    : null;
  const request = useExplorerRevealStore((state) =>
    revealKey ? (state.requests[revealKey] ?? null) : null,
  );
  const scroll = useRevealScroll({ listRows: input.listRows, treeListRef: input.treeListRef });
  const isLiveRef = useRevealLiveness({ isActive, revealKey, onAbandon: scroll.cancel });
  const startedRequestIdRef = useRef<number | null>(null);
  const canStart = isActive && input.isTreeRestored && directories.has(".");

  const finishReveal = useCallback(
    (result: FinishedReveal | null) => {
      // Hidden or unmounted before finishing: abandoned, so the tree stays where it is.
      if (!result || !isLiveRef.current) {
        return;
      }
      if (result.outcome === "not-found") {
        toast.error(t("workspace.fileExplorer.reveal.notFound"));
        return;
      }
      if (result.outcome === "hidden") {
        toast.show(t("workspace.fileExplorer.reveal.hidden"));
      }
      // A failed listing already shows the tree's own error state.
      const selectPath = result.plan.selectPath;
      if (result.outcome === "listing-failed" || !selectPath) {
        return;
      }
      selectExplorerEntry(selectPath);
      scroll.scrollTo(selectPath);
    },
    [isLiveRef, scroll, selectExplorerEntry, t, toast],
  );

  useEffect(() => {
    if (!request || !revealKey || !workspaceStateKey) {
      return;
    }
    if (startedRequestIdRef.current === request.requestId) {
      return;
    }
    if (isExplorerRevealRequestExpired(request, Date.now())) {
      clearPendingReveal(revealKey);
      return;
    }
    if (!canStart) {
      return;
    }
    startedRequestIdRef.current = request.requestId;
    scroll.cancel();
    void runRevealRequest({
      revealKey,
      workspaceStateKey,
      request,
      directories,
      showHiddenFiles,
      requestDirectoryListing,
      setExpandedPathsForWorkspace,
    }).then(finishReveal);
  }, [
    canStart,
    directories,
    finishReveal,
    request,
    requestDirectoryListing,
    revealKey,
    scroll,
    setExpandedPathsForWorkspace,
    showHiddenFiles,
    workspaceStateKey,
  ]);

  return {
    onScrollToIndexFailed: scroll.onScrollToIndexFailed,
    onListLayout: scroll.onListLayout,
    onListScroll: scroll.onListScroll,
    onListContentSizeChange: scroll.onListContentSizeChange,
  };
}
