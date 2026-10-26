"""SmartFix — deterministic DOCX correction (Phase 12).

PalCert may change deterministic document formatting, but it must never
silently change academic meaning. Everything in this package is built around
that one sentence: a closed vocabulary of property changes, a plan the user
approves before anything is written, and proofs computed from the corrected
package that the visible text, the media, the field instructions and the
relationships all came through untouched.
"""
