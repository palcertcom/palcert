import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Field, FormError, FormShell, FormSuccess, SubmitButton } from '../auth-form';

describe('Field accessibility', () => {
  it('associates a real label with the input', () => {
    render(
      <Field label="Email address" type="email" value="" onChange={vi.fn()} autoComplete="email" />,
    );

    const input = screen.getByLabelText('Email address');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('type', 'email');
  });

  it('sets the autocomplete value password managers rely on', () => {
    const { rerender } = render(
      <Field
        label="Password"
        type="password"
        value=""
        onChange={vi.fn()}
        autoComplete="current-password"
      />,
    );
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');

    rerender(
      <Field
        label="New password"
        type="password"
        value=""
        onChange={vi.fn()}
        autoComplete="new-password"
      />,
    );
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('uses one-time-code and a numeric keypad for verification codes', () => {
    render(
      <Field
        label="Verification code"
        type="text"
        value=""
        onChange={vi.fn()}
        autoComplete="one-time-code"
        inputMode="numeric"
        maxLength={6}
      />,
    );

    const input = screen.getByLabelText('Verification code');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('maxlength', '6');
  });

  it('never disables paste or blocks the input', () => {
    render(
      <Field
        label="Password"
        type="password"
        value=""
        onChange={vi.fn()}
        autoComplete="new-password"
      />,
    );

    const input = screen.getByLabelText('Password');
    expect(input).not.toHaveAttribute('onpaste');
    expect(input).not.toBeDisabled();
    expect(input).not.toHaveAttribute('readonly');
  });

  it('links a hint to the input via aria-describedby', () => {
    render(
      <Field
        label="Password"
        type="password"
        value=""
        onChange={vi.fn()}
        autoComplete="new-password"
        hint="Use at least 12 characters."
      />,
    );

    const input = screen.getByLabelText('Password');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('Use at least 12 characters.');
  });

  it('announces a field error and marks the input invalid', () => {
    render(
      <Field
        label="Confirm password"
        type="password"
        value=""
        onChange={vi.fn()}
        autoComplete="new-password"
        error="The two passwords do not match."
      />,
    );

    const input = screen.getByLabelText('Confirm password');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('The two passwords do not match.');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('marks a field required unless explicitly optional', () => {
    const { rerender } = render(
      <Field label="Email" type="email" value="" onChange={vi.fn()} autoComplete="email" />,
    );
    expect(screen.getByLabelText('Email')).toBeRequired();

    rerender(
      <Field
        label="Email"
        type="email"
        value=""
        onChange={vi.fn()}
        autoComplete="email"
        required={false}
      />,
    );
    expect(screen.getByLabelText('Email')).not.toBeRequired();
  });

  it('gives each rendered field a unique id', () => {
    render(
      <>
        <Field label="First" type="text" value="" onChange={vi.fn()} autoComplete="off" />
        <Field label="Second" type="text" value="" onChange={vi.fn()} autoComplete="off" />
      </>,
    );

    expect(screen.getByLabelText('First').id).not.toBe(screen.getByLabelText('Second').id);
  });
});

describe('form feedback', () => {
  it('announces errors assertively and successes politely', () => {
    const { rerender } = render(<FormError message="Incorrect email address or password." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Incorrect email address or password.');

    rerender(<FormSuccess message="Your changes have been saved." />);
    expect(screen.getByRole('status')).toHaveTextContent('Your changes have been saved.');
  });

  it('renders nothing when there is no message', () => {
    const { container } = render(<FormError message={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SubmitButton', () => {
  it('is a real submit button', () => {
    render(<SubmitButton label="Sign in" pendingLabel="Please wait…" pending={false} />);

    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).not.toBeDisabled();
  });

  it('communicates pending state to assistive technology', () => {
    render(<SubmitButton label="Sign in" pendingLabel="Please wait…" pending />);

    const button = screen.getByRole('button', { name: 'Please wait…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});

describe('FormShell', () => {
  it('renders a single level-one heading', () => {
    render(
      <FormShell title="Sign in to PalCert" subtitle="Use your email address and password.">
        <p>body</p>
      </FormShell>,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in to PalCert');
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
