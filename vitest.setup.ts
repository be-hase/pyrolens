import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library registers its own cleanup only when vitest's globals are
// on; they are not, so each file's renders are torn down here instead.
afterEach(cleanup);

// jsdom does no layout and ships no scrollIntoView, but components that keep
// a highlighted option in view call it on every keystroke.
Element.prototype.scrollIntoView = () => {};
