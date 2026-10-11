/**
 * A hard daily spending cap for Claude. Everything that runs all day (sonar,
 * sound recognition, speech to text, the three role agents) is local and
 * free; Claude is only called for the rare hard cases, and never past the cap.
 */

/** US dollars per million tokens (input, output). Unknown models are priced like Sonnet, to be safe. */
function price(model: string): [number, number] {
  if (/haiku-4-5|haiku-4\.5/.test(model)) return [1, 5];
  if (/haiku/.test(model)) return [0.8, 4];
  if (/opus/.test(model)) return [15, 75];
  return [3, 15];
}

export interface BudgetState {
  day: string;
  dollars: number;
  calls: number;
  input: number;
  output: number;
  /** Calls skipped because the cap was reached. */
  skipped: number;
}

export class Budget {
  state: BudgetState;

  constructor(
    public dailyUsd: number,
    private readonly model: () => string,
    saved: BudgetState | null = null,
    private readonly save: (s: BudgetState) => void = () => {},
  ) {
    this.state = saved && saved.day === today() ? saved : fresh();
  }

  private roll(): void {
    if (this.state.day !== today()) this.state = fresh();
  }

  /** May we make one more call today? Worst case a call costs about a cent. */
  canSpend(): boolean {
    this.roll();
    const ok = this.state.dollars + 0.01 <= this.dailyUsd;
    if (!ok) {
      this.state.skipped++;
      this.save(this.state);
    }
    return ok;
  }

  add(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } | undefined): void {
    if (!u) return;
    this.roll();
    const [pi, po] = price(this.model());
    const input = u.input_tokens + (u.cache_read_input_tokens ?? 0);
    this.state.calls++;
    this.state.input += input;
    this.state.output += u.output_tokens;
    this.state.dollars += (u.input_tokens * pi + (u.cache_read_input_tokens ?? 0) * pi * 0.1 + u.output_tokens * po) / 1e6;
    this.save(this.state);
  }

  summary(): { today: number; cap: number; calls: number; skipped: number } {
    this.roll();
    return { today: +this.state.dollars.toFixed(4), cap: this.dailyUsd, calls: this.state.calls, skipped: this.state.skipped };
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function fresh(): BudgetState {
  return { day: today(), dollars: 0, calls: 0, input: 0, output: 0, skipped: 0 };
}
