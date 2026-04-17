import type { IngressAdapter } from "@/server/channels.ts";

export function createWebIngressAdapter(): IngressAdapter {
  return {
    detachedResponseStatus: 202,
    async handle(request) {
      return {
        messages: [{ message: request.body as never }],
      };
    },
  };
}

export const webIngressAdapter = createWebIngressAdapter();

export default webIngressAdapter;
