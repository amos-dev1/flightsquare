'use client';

import { useId, useMemo, useRef, useState } from 'react';

export interface ComboboxOption {
  /** What gets submitted. */
  value: string;
  /** What a person reads and types against. */
  label: string;
  /** Shown to the right, quieter — the code behind the name. */
  hint?: string;
}

/**
 * Pick one of a short list by typing any part of its name.
 *
 * This replaces a `<datalist>`, which looked like it did the same job and did
 * not: a datalist filters on the option's **value**, and the value here is the
 * ICAO code. So the list showed "Cessna 172" while only `C172` would narrow
 * it — typing "cessna", which is what anybody does, matched nothing at all.
 *
 * Filtering runs over the label and the value together, so "cessna", "172"
 * and "c17" all find the same aeroplane. The list is short (a few dozen
 * types) and comes from a global reference table (§2.2), so it is filtered in
 * the browser rather than over the network — there is no query to debounce
 * and no spinner to show.
 *
 * Submits through a hidden input, so the form posts the code and the visible
 * field stays human. Free text is still allowed: `type_code` is optional and
 * the foreign key is what actually decides, which keeps an unknown type an
 * honest server-side error rather than something this control pretends to
 * know about.
 */
export function Combobox({
  name,
  options,
  defaultValue,
  placeholder,
  id,
}: {
  name: string;
  options: ComboboxOption[];
  defaultValue?: string;
  placeholder?: string;
  id?: string;
}) {
  const selected = options.find((o) => o.value === defaultValue);
  const [text, setText] = useState(selected ? selected.label : (defaultValue ?? ''));
  const [value, setValue] = useState(defaultValue ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, text]);

  function choose(option: ComboboxOption) {
    setText(option.label);
    setValue(option.value);
    setOpen(false);
  }

  return (
    <div className="relative">
      <input type="hidden" name={name} value={value} />
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          // Typing past a choice clears it: the hidden value must never
          // disagree with what the field says.
          setValue('');
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // A click on an option fires after blur, so closing is deferred long
        // enough for the click to land.
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (event.key === 'Enter' && open && matches[active]) {
            // Only when the list is open, so Enter still submits the form.
            event.preventDefault();
            choose(matches[active]);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
        className="h-11 w-full rounded-lg border border-control bg-surface px-3 text-base text-navy"
      />

      {open && matches.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-sm"
        >
          {matches.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                // onMouseDown, not onClick: mousedown precedes blur, so the
                // choice is made before the list can close under the cursor.
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                  choose(option);
                }}
                onMouseEnter={() => setActive(index)}
                className={`flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-base ${
                  index === active ? 'bg-selected' : 'hover:bg-subtle'
                }`}
              >
                <span>{option.label}</span>
                {option.hint ? (
                  <span className="shrink-0 text-xs text-secondary">{option.hint}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
