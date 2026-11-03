document.querySelector('#welcome').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = document.querySelector('#name').value;
  document.querySelector('#message').textContent = `Welcome, ${name}!`;
});
