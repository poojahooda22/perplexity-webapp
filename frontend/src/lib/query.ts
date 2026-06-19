import { QueryClient } from "@tanstack/react-query";

// One client for the whole app. Defaults tuned for the Finance tab's cached endpoints:
// the backend already caches upstream data, so the browser just needs to poll *our*
// endpoints gently — staleTime keeps it from refetching on every mount/focus.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
