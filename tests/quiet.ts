// Importe ANTES do servidor. O servidor escreve logs no stdout, e o runner do `node --test` lê os eventos do
// processo filho pelo mesmo canal: texto intercalado às vezes corrompe a leitura ("Unable to deserialize cloned
// data ...") e derruba o arquivo inteiro de teste de forma intermitente.
const noop = (): void => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;
