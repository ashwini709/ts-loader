var splash, loaderBox, icon, progress; // dom elements
var timeout;

function checkOrientation() {
  if (window.orientation == 0 || window.orientation == 180) { // portrait
    icon.classList.add('portrait');
  } else { //landscape
    icon.classList.remove('portrait');
  }
}

window.addEventListener('orientationchange', checkOrientation);

function show() {
  window.clearTimeout(timeout);
  splash.style.display = '';
  splash.style.transition = '';
  splash.style.webkitTransition = '';
  splash.style.opacity = 1;
}

function hide() {
  hideLoader();

  window.clearTimeout(timeout);
  timeout = window.setTimeout(function () {
    splash.style.transition = 'opacity 300ms linear';
    splash.style.webkitTransition = 'opacity 300ms linear';
    splash.style.opacity = 0;

    timeout = window.setTimeout(function () {
      splash.style.display = 'none';
    }, 300);
  }, 300);
}

function setProgress(value) {
  progress.textContent = value;
}

function setProgressScale(scale) {
  loaderBox.style.webkitTransform = 'scale(' + scale + ')';
  loaderBox.style.transform = 'scale(' + scale + ')';
}

function setIconVerticalPosition(position) {
  icon.style.webkitTransform = 'translateY(' + position + ')';
  icon.style.transform = 'translateY(' + position + ')';
}

function showLoader() {
  setIconVerticalPosition('-40px');
  setProgressScale(1);
}

function hideLoader() {
  setIconVerticalPosition(0);
  setProgressScale(0);
}

function setStatusBarHeight(height) {
  splash.style.marginTop =  height + 'px';
}

function create() {
  splash = document.createElement('div');
  splash.id = 'ts-splash-screen';

  icon = document.createElement('div');
  icon.id = 'ts-splash-icon';
  splash.appendChild(icon);

  loaderBox = document.createElement('div');
  loaderBox.id = 'ts-splash-loader';
  icon.appendChild(loaderBox);

  var tsSplashSpinner = document.createElement('div');
  tsSplashSpinner.id = 'ts-splash-spinner';
  loaderBox.appendChild(tsSplashSpinner);
  progress = document.createElement('div');
  progress.id = 'ts-splash-progress';
  loaderBox.appendChild(progress);

  document.body.appendChild(splash);

  checkOrientation();
}

module.exports = {
  create: create,
  show: show,
  hide: hide,
  setProgress: setProgress,
  showLoader: showLoader,
  hideLoader: hideLoader,
  setStatusBarHeight: setStatusBarHeight
};
