import { useNetworkState } from 'expo-network';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { sync } from './sync';

/**
 * When the queue actually gets flushed.
 *
 * This is the piece §8.2 was missing. The write path was finished and
 * tested; the *trigger* was a save and one screen's focus effect, so a pilot
 * who logged a flight at a tiedown with no signal and did not happen to
 * reopen the Fleet tab never sent it. The flight sat in SQLite, the meters
 * stayed stale, and §3.4's failure mode arrived by a road §8.2 was written
 * to close.
 *
 * Two triggers, and the order of importance is the opposite of the obvious
 * one:
 *
 * **The app coming to the foreground** is the dominant real case. The phone
 * was in a pocket on the walk back to the car; by the time anybody looks at
 * it again there is signal, and looking at it is the event.
 *
 * **The network coming back** catches the rest: the app was left open on the
 * ramp and the bars returned on their own.
 *
 * Deliberately *not* a background task. `expo-background-task` means a
 * background mode in the entitlements and a conversation at App Review, and
 * it would buy minutes — a queued flight is not urgent, it is just not
 * allowed to be forgotten. Foreground plus reconnect is honest, and the
 * README says so rather than implying the phone syncs in a pocket.
 */
export function useBackgroundSync(): void {
  const network = useNetworkState();
  const wasConnected = useRef<boolean | undefined>(undefined);

  // Reconnection, not connection. Firing on every render where the network
  // happens to be up would hammer a server that is merely slow.
  useEffect(() => {
    const connected = network.isInternetReachable ?? network.isConnected;
    if (connected && wasConnected.current === false) {
      void sync().catch(() => undefined);
    }
    if (connected !== undefined) wasConnected.current = connected;
  }, [network.isConnected, network.isInternetReachable]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      // Failing is not an error here: there may still be no signal, and the
      // queue is exactly where the write should stay if so.
      if (state === 'active') void sync().catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);
}
