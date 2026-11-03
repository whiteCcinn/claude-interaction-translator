import type { Engine, Mounted, MountTarget } from "claude-code/testing"
import type { RenderComponent, RenderPropsOf, RenderSurface } from "claude-code"

let serial = 0

// A newly rendered response is stored before mounting in these fixtures.
// Resume tests intentionally mount directly, without a response append.
export async function mountFreshDisplay<P extends RenderSurface, C extends RenderComponent>($: Engine, target: MountTarget<P, C>): Promise<Mounted<P, C>> {
  if (target.component !== "AssistantMessage") return $.ui.mount(target)
  const requestId = target.requestId ?? `fresh-response-${++serial}`
  const props = target.props as RenderPropsOf["AssistantMessage"]
  await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: requestId, message: { type: "assistant", content: [{ type: "text", text: props.text }] } })
  return $.ui.mount({ ...target, requestId })
}
