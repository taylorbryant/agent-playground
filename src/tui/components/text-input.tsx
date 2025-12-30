import React, { useState, useEffect, useRef, useCallback } from "react";
import { Text, useInput } from "ink";
import chalk from "chalk";

type TextInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onCursorChange?: (position: number) => void;
  cursorPosition?: number;
  onUpArrow?: () => boolean | void;
  onDownArrow?: () => boolean | void;
  onTab?: () => boolean | void;
  onCtrlN?: () => boolean | void;
  onCtrlP?: () => boolean | void;
  onReturn?: () => boolean | void;
  placeholder?: string;
  focus?: boolean;
  showCursor?: boolean;
};

/**
 * Find the position of the previous word boundary (for Option+Delete)
 */
function findPrevWordBoundary(value: string, cursorOffset: number): number {
  if (cursorOffset <= 0) return 0;

  let pos = cursorOffset - 1;

  // Skip any trailing whitespace
  while (pos > 0 && /\s/.test(value[pos]!)) {
    pos--;
  }

  // Skip the word characters
  while (pos > 0 && !/\s/.test(value[pos - 1]!)) {
    pos--;
  }

  return pos;
}

export function TextInput({
  value: externalValue,
  onChange,
  onSubmit,
  onCursorChange,
  cursorPosition: externalCursorPosition,
  onUpArrow,
  onDownArrow,
  onTab,
  onCtrlN,
  onCtrlP,
  onReturn,
  placeholder = "",
  focus = true,
  showCursor = true
}: TextInputProps) {
  // Internal state - this is the source of truth during typing
  const [internalValue, setInternalValue] = useState(externalValue || "");
  const [cursorOffset, setCursorOffset] = useState((externalValue || "").length);
  const [cursorWidth, setCursorWidth] = useState(0);

  // Refs to always have access to latest values in useInput callback
  const valueRef = useRef(internalValue);
  const cursorRef = useRef(cursorOffset);

  // Keep refs in sync with state
  valueRef.current = internalValue;
  cursorRef.current = cursorOffset;

  // Track last external values to detect intentional parent changes
  const lastExternalValueRef = useRef(externalValue);
  const lastExternalCursorRef = useRef(externalCursorPosition);

  // Sync with external value when parent explicitly changes it
  // (e.g., after autocomplete selection or reset)
  useEffect(() => {
    if (externalValue !== lastExternalValueRef.current) {
      lastExternalValueRef.current = externalValue;
      setInternalValue(externalValue || "");
      // Also adjust cursor if it's beyond the new value length
      setCursorOffset((prev) => Math.min(prev, (externalValue || "").length));
    }
  }, [externalValue]);

  // Sync with external cursor position when parent explicitly changes it
  useEffect(() => {
    if (
      externalCursorPosition !== undefined &&
      externalCursorPosition !== lastExternalCursorRef.current
    ) {
      lastExternalCursorRef.current = externalCursorPosition;
      setCursorOffset(Math.min(externalCursorPosition, valueRef.current.length));
    }
  }, [externalCursorPosition]);

  // Clamp cursor when value changes
  useEffect(() => {
    if (!focus || !showCursor) return;
    setCursorOffset((prev) => Math.min(prev, internalValue.length));
  }, [internalValue, focus, showCursor]);

  // Helper to update value and notify parent
  const updateValue = useCallback(
    (newValue: string, newCursor: number) => {
      setInternalValue(newValue);
      setCursorOffset(newCursor);
      lastExternalValueRef.current = newValue;
      lastExternalCursorRef.current = newCursor;
      onChange(newValue);
      onCursorChange?.(newCursor);
    },
    [onChange, onCursorChange]
  );

  // Helper to update cursor only
  const updateCursor = useCallback(
    (newCursor: number) => {
      setCursorOffset(newCursor);
      lastExternalCursorRef.current = newCursor;
      onCursorChange?.(newCursor);
    },
    [onCursorChange]
  );

  const cursorActualWidth = cursorWidth;
  const value = internalValue;
  let renderedValue = value;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  // Fake mouse cursor
  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(" ");

    renderedValue = value.length > 0 ? "" : chalk.inverse(" ");

    let i = 0;
    for (const char of value) {
      renderedValue +=
        i >= cursorOffset - cursorActualWidth && i <= cursorOffset
          ? chalk.inverse(char)
          : char;
      i++;
    }

    if (value.length > 0 && cursorOffset === value.length) {
      renderedValue += chalk.inverse(" ");
    }
  }

  useInput(
    (input, key) => {
      // Always read from refs to get latest values
      const currentValue = valueRef.current;
      const currentCursor = cursorRef.current;

      // Handle up arrow - let parent intercept if needed
      if (key.upArrow) {
        if (onUpArrow?.()) return;
        return; // Still block if no handler
      }

      // Handle down arrow - let parent intercept if needed
      if (key.downArrow) {
        if (onDownArrow?.()) return;
        return; // Still block if no handler
      }

      // Handle tab - let parent intercept if needed
      if (key.tab && !key.shift) {
        if (onTab?.()) return;
        return; // Still block if no handler
      }

      // Handle Ctrl+N - let parent intercept if needed
      if (key.ctrl && input === "n") {
        if (onCtrlN?.()) return;
      }

      // Handle Ctrl+P - let parent intercept if needed
      if (key.ctrl && input === "p") {
        if (onCtrlP?.()) return;
      }

      // Ignore certain key combinations
      if ((key.ctrl && input === "c") || (key.shift && key.tab)) {
        return;
      }

      if (key.return) {
        // Let parent intercept return (e.g., for autocomplete)
        if (onReturn?.()) return;
        if (onSubmit) {
          onSubmit(currentValue);
        }
        return;
      }

      let nextCursorOffset = currentCursor;
      let nextValue = currentValue;
      let nextCursorWidth = 0;

      if (key.leftArrow) {
        if (showCursor) {
          // Option+Left: Move to previous word boundary
          if (key.meta) {
            nextCursorOffset = findPrevWordBoundary(currentValue, currentCursor);
          } else {
            nextCursorOffset--;
          }
        }
      } else if (key.rightArrow) {
        if (showCursor) {
          // Option+Right: Move to next word boundary
          if (key.meta) {
            let pos = currentCursor;
            // Skip current word
            while (pos < currentValue.length && !/\s/.test(currentValue[pos]!)) {
              pos++;
            }
            // Skip whitespace
            while (pos < currentValue.length && /\s/.test(currentValue[pos]!)) {
              pos++;
            }
            nextCursorOffset = pos;
          } else {
            nextCursorOffset++;
          }
        }
      } else if (key.ctrl && input === "u") {
        // Ctrl+U: Delete entire line to the left (Cmd+Delete equivalent)
        if (currentCursor > 0) {
          nextValue = currentValue.slice(currentCursor);
          nextCursorOffset = 0;
        }
      } else if (key.ctrl && input === "w") {
        // Ctrl+W: Delete previous word (unix-style, Option+Delete equivalent)
        if (currentCursor > 0) {
          const wordBoundary = findPrevWordBoundary(currentValue, currentCursor);
          nextValue =
            currentValue.slice(0, wordBoundary) + currentValue.slice(currentCursor);
          nextCursorOffset = wordBoundary;
        }
      } else if (key.backspace || key.delete) {
        if (currentCursor > 0) {
          // Option+Delete (meta + delete): Delete previous word
          if (key.delete && key.meta) {
            const wordBoundary = findPrevWordBoundary(currentValue, currentCursor);
            nextValue =
              currentValue.slice(0, wordBoundary) + currentValue.slice(currentCursor);
            nextCursorOffset = wordBoundary;
          } else {
            // Regular backspace: delete one character
            nextValue =
              currentValue.slice(0, currentCursor - 1) +
              currentValue.slice(currentCursor);
            nextCursorOffset--;
          }
        }
      } else {
        // Regular character input
        nextValue =
          currentValue.slice(0, currentCursor) +
          input +
          currentValue.slice(currentCursor);
        nextCursorOffset += input.length;

        if (input.length > 1) {
          nextCursorWidth = input.length;
        }
      }

      // Clamp cursor position
      if (nextCursorOffset < 0) {
        nextCursorOffset = 0;
      }
      if (nextCursorOffset > nextValue.length) {
        nextCursorOffset = nextValue.length;
      }

      setCursorWidth(nextCursorWidth);

      if (nextValue !== currentValue) {
        updateValue(nextValue, nextCursorOffset);
      } else if (nextCursorOffset !== currentCursor) {
        updateCursor(nextCursorOffset);
      }
    },
    { isActive: focus }
  );

  return (
    <Text>
      {placeholder
        ? value.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}
