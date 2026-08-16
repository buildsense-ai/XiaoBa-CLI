# Product

## Register

product

## Users

CatsCo operators and developers configuring a local XiaoBa agent runtime. They use the dashboard to connect services, select model runtimes, inspect operational state, and tune background automation without editing environment files by hand.

## Product Purpose

XiaoBa CLI provides a dependable local agent runtime and operational dashboard. Success means operators can understand which configuration controls each runtime component, make changes without exposing secrets, and predict which model and provider every agent will use.

## Brand Personality

Calm, capable, and direct. The interface should feel like a trustworthy desktop operations tool: approachable for routine setup, precise when configuration has runtime consequences.

## Anti-references

Avoid marketing-page composition, ornamental cards, novelty controls, excessive animation, and ambiguous settings that silently inherit values. Do not make operational configuration feel playful or visually louder than its consequences warrant.

## Design Principles

1. Make ownership explicit: show which runtime component owns and consumes each setting.
2. Prefer predictable controls: use familiar forms, toggles, and progressive disclosure.
3. Preserve safe defaults: existing behavior should remain available through an explicit inheritance choice.
4. Keep secrets private: communicate presence and replacement state without revealing stored values.
5. Surface consequences at the point of change: explain when a restart or later scheduled run will apply a setting.

## Accessibility & Inclusion

Target WCAG 2.1 AA. Preserve keyboard access and visible focus states, do not rely on color alone for state, support reduced motion, and keep configuration labels and validation messages clear in both desktop and narrow layouts.
