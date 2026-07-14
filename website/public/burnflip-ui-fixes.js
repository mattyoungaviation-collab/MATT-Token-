(() => {
  'use strict';

  const choices = [...document.querySelectorAll('#coin-flip .choice[data-choice]')];
  for (const choice of choices) {
    choice.addEventListener('click', () => {
      for (const button of choices) {
        const selected = button === choice;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      }
    });
  }

  const heroLead = document.querySelector('.hero .lead');
  if (heroLead) {
    heroLead.textContent = 'Your home for MATT utility. Connect through WalletConnect, check your status, enter MATT BurnFlip, and meet the holders building MATT together.';
  }
})();
