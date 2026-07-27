// Cohesive, page-rendered menus for every single-select control.
(function initializeCustomSelects() {
    let generatedId = 0;
    let openControl = null;

    function optionElements(select) {
        return Array.from(select.options);
    }

    function selectedOption(select) {
        return optionElements(select).find(option => option.selected)
            || optionElements(select)[0]
            || null;
    }

    function closeControl(control, { restoreFocus = false } = {}) {
        if (!control) return;
        control.wrapper.classList.remove('is-open', 'opens-up');
        control.menu.hidden = true;
        control.menu.classList.remove('custom-select-menu--portal');
        control.menu.removeAttribute('style');
        if (control.menu.parentNode !== control.wrapper) {
            control.wrapper.appendChild(control.menu);
        }
        control.trigger.setAttribute('aria-expanded', 'false');
        if (openControl === control) openControl = null;
        if (restoreFocus) control.trigger.focus();
    }

    function closeOpenControl(except = null) {
        if (openControl && openControl !== except) closeControl(openControl);
    }

    function handleDocumentScroll(event) {
        if (openControl?.menu.contains(event.target)) return;
        closeOpenControl();
    }

    function createActionIcon(action) {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('width', '14');
        icon.setAttribute('height', '14');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '1.9');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        icon.setAttribute('aria-hidden', 'true');

        const paths = action === 'edit'
            ? ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4L16.5 3.5z']
            : ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v5', 'M14 11v5'];
        for (const pathData of paths) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', pathData);
            icon.appendChild(path);
        }
        return icon;
    }

    function createOptionButton(control, option, flatIndex) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'custom-select-option';
        button.id = `${control.menu.id}-option-${flatIndex}`;
        button.dataset.optionIndex = String(flatIndex);
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(option.selected));
        button.disabled = option.disabled;

        const check = document.createElement('span');
        check.className = 'custom-select-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = '✓';

        const label = document.createElement('span');
        label.className = 'custom-select-option-label';
        label.textContent = option.textContent;

        button.append(check, label);
        button.addEventListener('click', () => {
            if (option.disabled) return;
            control.select.value = option.value;
            control.select.dispatchEvent(new Event('input', { bubbles: true }));
            control.select.dispatchEvent(new Event('change', { bubbles: true }));
            renderControl(control);
            closeControl(control, { restoreFocus: true });
        });

        if (option.dataset.connectionEditable !== 'true') {
            return button;
        }

        const row = document.createElement('div');
        row.className = 'custom-select-option-row';
        row.appendChild(button);

        const actions = document.createElement('span');
        actions.className = 'custom-select-option-actions';
        for (const action of ['edit', 'delete']) {
            const actionButton = document.createElement('button');
            actionButton.type = 'button';
            actionButton.className = `custom-select-option-action custom-select-option-action--${action}`;
            actionButton.title = `${action === 'edit' ? 'Edit' : 'Delete'} ${option.textContent}`;
            actionButton.setAttribute(
                'aria-label',
                `${action === 'edit' ? 'Edit' : 'Delete'} saved connection ${option.textContent}`
            );
            actionButton.appendChild(createActionIcon(action));
            actionButton.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                control.select.dispatchEvent(new CustomEvent('custom-select-action', {
                    bubbles: true,
                    detail: {
                        action,
                        value: option.value,
                        label: option.textContent
                    }
                }));
                closeControl(control, { restoreFocus: true });
            });
            actions.appendChild(actionButton);
        }
        row.appendChild(actions);
        return row;
    }

    function renderControl(control) {
        const { select, trigger, value, menu } = control;
        const current = selectedOption(select);
        value.textContent = current ? current.textContent : '';
        trigger.disabled = select.disabled;
        trigger.setAttribute('aria-disabled', String(select.disabled));
        trigger.title = current ? current.textContent : '';
        menu.replaceChildren();

        let flatIndex = 0;
        const appendOptions = (container, options) => {
            for (const option of options) {
                container.appendChild(createOptionButton(control, option, flatIndex));
                flatIndex += 1;
            }
        };

        for (const child of Array.from(select.children)) {
            if (child instanceof HTMLOptGroupElement) {
                const group = document.createElement('div');
                group.className = 'custom-select-group';
                group.setAttribute('role', 'group');
                group.setAttribute('aria-label', child.label);

                const groupLabel = document.createElement('div');
                groupLabel.className = 'custom-select-group-label';
                groupLabel.textContent = child.label;
                group.appendChild(groupLabel);
                appendOptions(group, Array.from(child.children));
                menu.appendChild(group);
            } else if (child instanceof HTMLOptionElement) {
                menu.appendChild(createOptionButton(control, child, flatIndex));
                flatIndex += 1;
            }
        }

        const selectedButton = menu.querySelector(`[data-option-index="${select.selectedIndex}"]`);
        if (selectedButton) {
            selectedButton.classList.add('is-active');
            trigger.setAttribute('aria-activedescendant', selectedButton.id);
        } else {
            trigger.removeAttribute('aria-activedescendant');
        }
    }

    function open(control, focusDirection = 0) {
        if (control.select.disabled) return;
        closeOpenControl(control);
        renderControl(control);
        control.menu.hidden = false;
        control.menu.classList.add('custom-select-menu--portal');
        document.body.appendChild(control.menu);
        control.wrapper.classList.add('is-open');
        control.trigger.setAttribute('aria-expanded', 'true');
        openControl = control;

        const triggerRect = control.trigger.getBoundingClientRect();
        const requestedMinWidth = Number(control.select.dataset.customSelectMinWidth);
        const menuWidth = Math.min(
            window.innerWidth - 16,
            Math.max(triggerRect.width, Number.isFinite(requestedMinWidth) ? requestedMinWidth : 0)
        );
        const desiredHeight = Math.min(control.menu.scrollHeight + 8, 280);
        const roomBelow = window.innerHeight - triggerRect.bottom - 8;
        const roomAbove = triggerRect.top - 8;
        const opensUp = roomBelow < desiredHeight && roomAbove > roomBelow;
        const availableHeight = Math.max(80, opensUp ? roomAbove : roomBelow);
        const menuHeight = Math.min(desiredHeight, availableHeight);
        control.wrapper.classList.toggle('opens-up', opensUp);
        control.menu.style.left = `${triggerRect.left}px`;
        control.menu.style.width = `${menuWidth}px`;
        control.menu.style.maxHeight = `${Math.min(280, availableHeight)}px`;
        control.menu.style.top = opensUp
            ? `${Math.max(8, triggerRect.top - menuHeight - 6)}px`
            : `${triggerRect.bottom + 6}px`;

        const buttons = Array.from(control.menu.querySelectorAll('.custom-select-option:not(:disabled)'));
        let target = control.menu.querySelector('.custom-select-option[aria-selected="true"]:not(:disabled)');
        if (focusDirection > 0) target = buttons[0];
        if (focusDirection < 0) target = buttons.at(-1);
        target?.focus();
    }

    function moveOptionFocus(control, direction) {
        const buttons = Array.from(control.menu.querySelectorAll('.custom-select-option:not(:disabled)'));
        if (!buttons.length) return;
        const currentIndex = buttons.indexOf(document.activeElement);
        const nextIndex = currentIndex < 0
            ? 0
            : (currentIndex + direction + buttons.length) % buttons.length;
        buttons[nextIndex].focus();
    }

    function onMenuKeydown(control, event) {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveOptionFocus(control, 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveOptionFocus(control, -1);
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            const buttons = control.menu.querySelectorAll('.custom-select-option:not(:disabled)');
            const target = event.key === 'Home' ? buttons[0] : buttons[buttons.length - 1];
            target?.focus();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closeControl(control, { restoreFocus: true });
        } else if (event.key === 'Tab') {
            setTimeout(() => {
                if (!control.menu.contains(document.activeElement)) closeControl(control);
            }, 0);
        }
    }

    function enhanceSelect(select) {
        if (!(select instanceof HTMLSelectElement)
            || select.multiple
            || select.dataset.customSelectEnhanced === 'true') {
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'custom-select';
        if (select.style.width) wrapper.style.width = select.style.width;
        const requestedMinWidth = Number(select.dataset.customSelectMinWidth);
        if (Number.isFinite(requestedMinWidth) && requestedMinWidth > 0) {
            wrapper.style.minWidth = `${requestedMinWidth}px`;
        }

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'custom-select-trigger';
        trigger.setAttribute('role', 'combobox');
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');

        const value = document.createElement('span');
        value.className = 'custom-select-value';

        const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        arrow.classList.add('custom-select-arrow');
        arrow.setAttribute('width', '12');
        arrow.setAttribute('height', '12');
        arrow.setAttribute('viewBox', '0 0 24 24');
        arrow.setAttribute('fill', 'none');
        arrow.setAttribute('stroke', 'currentColor');
        arrow.setAttribute('stroke-width', '2.5');
        arrow.setAttribute('stroke-linecap', 'round');
        arrow.setAttribute('aria-hidden', 'true');
        const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        arrowPath.setAttribute('d', 'M6 9l6 6 6-6');
        arrow.appendChild(arrowPath);
        trigger.append(value, arrow);

        const menu = document.createElement('div');
        menu.className = 'custom-select-menu';
        menu.id = `${select.id || `custom-select-${++generatedId}`}-menu`;
        menu.setAttribute('role', 'listbox');
        menu.hidden = true;
        trigger.setAttribute('aria-controls', menu.id);

        if (select.id) {
            trigger.id = `${select.id}Button`;
            document.querySelectorAll('label[for]').forEach(label => {
                if (label.getAttribute('for') === select.id) {
                    label.setAttribute('for', trigger.id);
                }
            });
        }

        select.parentNode.insertBefore(wrapper, select);
        wrapper.append(select, trigger, menu);
        select.dataset.customSelectEnhanced = 'true';
        select.setAttribute('aria-hidden', 'true');
        select.hidden = true;
        select.tabIndex = -1;

        const control = { select, wrapper, trigger, value, menu };
        wrapper.customSelectControl = control;

        trigger.addEventListener('click', () => {
            if (wrapper.classList.contains('is-open')) {
                closeControl(control);
            } else {
                open(control);
            }
        });
        trigger.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                open(control, event.key === 'ArrowDown' ? 1 : -1);
            } else if (event.key === 'Escape') {
                closeControl(control);
            }
        });
        menu.addEventListener('click', event => event.stopPropagation());
        menu.addEventListener('keydown', event => onMenuKeydown(control, event));
        select.addEventListener('change', () => renderControl(control));
        renderControl(control);
    }

    function refreshSelect(select) {
        const control = select?.closest('.custom-select')?.customSelectControl;
        if (control) renderControl(control);
    }

    function enhanceWithin(root) {
        if (root instanceof HTMLSelectElement) enhanceSelect(root);
        root.querySelectorAll?.('select:not([multiple])').forEach(enhanceSelect);
    }

    document.addEventListener('DOMContentLoaded', () => {
        enhanceWithin(document);

        const observer = new MutationObserver(mutations => {
            const refresh = new Set();
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => {
                        if (node instanceof Element) enhanceWithin(node);
                    });
                }
                const select = mutation.target instanceof Element
                    ? mutation.target.closest('select')
                    : null;
                if (select?.dataset.customSelectEnhanced === 'true') refresh.add(select);
            }
            refresh.forEach(refreshSelect);
        });
        observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['disabled', 'label', 'selected', 'value']
        });

        document.addEventListener('pointerdown', event => {
            if (openControl
                && !openControl.wrapper.contains(event.target)
                && !openControl.menu.contains(event.target)) {
                closeControl(openControl);
            }
        });
        window.addEventListener('resize', () => closeOpenControl());
        document.addEventListener('scroll', handleDocumentScroll, true);
    });

    window.refreshCustomSelect = refreshSelect;
})();
