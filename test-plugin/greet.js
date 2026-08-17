export function greet(name) {
  if (!name) return 'Hello, stranger!';
  return `Hello, ${name}!`;
}

export function farewell(name) {
  return `Goodbye, ${name || 'stranger'}!`;
}

export function shout(name) {
  return greet(name).toUpperCase();
}
