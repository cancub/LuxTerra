import test from 'node:test';
import assert from 'node:assert/strict';

function ensureDomStubs() {
  if (typeof globalThis.document === 'undefined') {
    const makeEl = () => ({
      className: '',
      style: {},
      innerHTML: '',
      dataset: {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      addEventListener: () => {},
      appendChild: () => {},
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
    });
    globalThis.document = {
      createElement: () => makeEl(),
      body: { appendChild: () => {} },
    };
  }
}

ensureDomStubs();

import { PlaybackEngine } from '../src/components/PlaybackEngine.js';
import { runSimulation } from '../src/services/api.js';

test('PlaybackEngine: play() is guarded when no simulation is loaded', () => {
  const container = document.createElement('div');
  const engine = new PlaybackEngine(container);
  engine.play();
  assert.equal(engine.isPlaying, false);
});

test('PlaybackEngine: setCurrentStep preserves fractionalStep during playback tick', () => {
  const container = document.createElement('div');
  const engine = new PlaybackEngine(container);
  engine.setSimulationContext(100, 15);
  engine.isPlaying = true;
  engine.currentStep = 5;
  engine.fractionalStep = 5.75;

  // Simulating TimeScrubber echoing back currentStep during playback
  engine.setCurrentStep(5);
  assert.equal(engine.fractionalStep, 5.75);

  // Explicit seek to a different step resets fractionalStep
  engine.setCurrentStep(12);
  assert.equal(engine.currentStep, 12);
  assert.equal(engine.fractionalStep, 12);
  engine.isPlaying = false;
});

test('runSimulation preserves plain-text proxy errors and enforces timeout', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway from upstream proxy',
    });

    await assert.rejects(
      () => runSimulation({ date: '2026-06-21' }, null, 5000),
      /HTTP 502: Bad Gateway from upstream proxy/
    );

    globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });

    await assert.rejects(
      () => runSimulation({ date: '2026-06-21' }, null, 20),
      /timed out/i
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
