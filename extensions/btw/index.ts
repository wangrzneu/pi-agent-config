import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { askBtw, BtwError } from "./btw-service.ts";
import { BtwViewer, type BtwExchange } from "./btw-viewer.ts";

const MAX_HISTORY = 20;

interface AnswerResult {
  answer?: string;
  error?: string;
  cancelled?: boolean;
}

export default function btwExtension(pi: ExtensionAPI): void {
  const history: BtwExchange[] = [];

  const showHistory = async (
    ctx: ExtensionCommandContext,
    index = history.length - 1,
  ): Promise<void> => {
    if (history.length === 0) return;
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      return new BtwViewer(
        tui,
        theme,
        history,
        index,
        () => done(),
        () => history.splice(0),
      );
    });
  };

  pi.registerCommand("btw", {
    description: "Ask an ephemeral side question without changing the main conversation",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw is only available in interactive TUI mode.", "warning");
        return;
      }

      let question = args.trim();
      if (!question) {
        if (history.length > 0) {
          await showHistory(ctx);
          return;
        }
        question =
          (await ctx.ui.editor(
            "BTW — temporary side question",
            "",
          ))?.trim() ?? "";
        if (!question) return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected.", "error");
        return;
      }

      const result = await ctx.ui.custom<AnswerResult>(
        (tui, theme, _keybindings, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            `Answering BTW with ${ctx.model!.id}…`,
          );
          let finished = false;
          const finish = (value: AnswerResult) => {
            if (finished) return;
            finished = true;
            done(value);
          };
          loader.onAbort = () => finish({ cancelled: true });
          void askBtw(question, ctx, loader.signal)
            .then((answer) => finish({ answer }))
            .catch((error) =>
              finish({
                error:
                  error instanceof BtwError
                    ? error.message
                    : "Side question failed.",
              }),
            );
          return loader;
        },
      );

      if (result.cancelled) return;
      if (!result.answer) {
        ctx.ui.notify(result.error || "Side question failed.", "error");
        return;
      }

      history.push({ question, answer: result.answer });
      if (history.length > MAX_HISTORY) history.shift();
      await showHistory(ctx);
    },
  });
}
