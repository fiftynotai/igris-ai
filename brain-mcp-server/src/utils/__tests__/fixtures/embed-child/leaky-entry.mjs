// TD-525 fixture ENTRY (ES1c): runs leaky.mjs's embed once as a plain process, with no embed
// child involved, so the stdout-leak control does not depend on the code under test.
import { generateEmbedding } from './leaky.mjs';

await generateEmbedding('leak');
