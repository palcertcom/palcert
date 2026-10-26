import { act, useState } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Field } from '../auth-form';

/**
 * Text typed before React takes over the page (Phase 20 Checkpoint 8).
 *
 * Reproduces exactly what a slow connection does to the sign-in form: the
 * server's HTML is on screen, the person types into it, and only then does
 * React hydrate. Before the fix the component's state stayed `''`, so the form
 * posted empty strings and PalCert told the person to "check the information
 * you entered" — which was correct.
 */
function SignInLike({ onSubmitValue }: { onSubmitValue: (email: string) => void }) {
  const [email, setEmail] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmitValue(email);
      }}
    >
      <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
      <button type="submit">Sign in</button>
    </form>
  );
}

async function serverRenderTypeThenHydrate(typed: string) {
  const submitted = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);

  // 1. What the server sends.
  container.innerHTML = renderToString(<SignInLike onSubmitValue={submitted} />);
  // 2. The person types before any JavaScript has run.
  const input = container.querySelector('input') as HTMLInputElement;
  input.value = typed;
  // 3. React arrives.
  await act(async () => {
    hydrateRoot(container, <SignInLike onSubmitValue={submitted} />);
  });
  // 4. They press the button.
  await act(async () => {
    (container.querySelector('button') as HTMLButtonElement).click();
  });

  container.remove();
  return submitted;
}

describe('Field — input typed before hydration', () => {
  it('submits what the person typed, not the empty initial state', async () => {
    const submitted = await serverRenderTypeThenHydrate('reader@example.com');
    expect(submitted).toHaveBeenCalledWith('reader@example.com');
  });

  it('leaves an untouched field alone', async () => {
    const onChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const field = (
      <Field label="Email" type="email" value="" onChange={onChange} autoComplete="email" />
    );
    container.innerHTML = renderToString(field);
    await act(async () => {
      hydrateRoot(container, field);
    });
    expect(onChange).not.toHaveBeenCalled();
    container.remove();
  });

  it('does not overwrite a value the owner already set', () => {
    const onChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = renderToString(
      <Field
        label="Name"
        type="text"
        value="Set by owner"
        onChange={onChange}
        autoComplete="name"
      />,
    );
    return act(async () => {
      hydrateRoot(
        container,
        <Field
          label="Name"
          type="text"
          value="Set by owner"
          onChange={onChange}
          autoComplete="name"
        />,
      );
    }).then(() => {
      expect(onChange).not.toHaveBeenCalled();
      container.remove();
    });
  });
});
