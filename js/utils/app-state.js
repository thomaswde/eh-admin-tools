// Application State Management

const state = {
    connected: false,
    apiConfig: null,
    currentModule: 'dashboards',
    dashboards: [],
    filteredDashboards: [],
    users: [],
    filteredUsers: [],
    selectedDashboards: new Set(),
    currentPage: 1,
    itemsPerPage: 20,
    allUsers: []
};

function clearEnvironmentBoundContent() {
    // Dynamically loaded modules keep appliance data in private in-memory state.
    // Reloading is the only complete reset boundary, and the backend session
    // cookie survives so initializeApp() can restore the new connection.
    window.location.reload();
}

// Make state globally available
window.state = state;
window.clearEnvironmentBoundContent = clearEnvironmentBoundContent;
